/**
 * Describes an Anki export so we can plan how to import it.
 *
 *   npm run anki:inspect -- path/to/export.apkg        (or a .colpkg: File → Export → whole collection)
 *
 * Writes content/anki/<name>-report.json (decks, note types, fields, formatting used in each field,
 * tags), content/anki/<name>-sample.json (a few full notes of each note type) and
 * content/anki/<name>-notes.json (every note: deck, fields, tags), and prints a summary.
 * Nothing is uploaded.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { type AnkiCollection, readAnkiExport } from "./read";

const DIR = path.join("content", "anki");
const SAMPLES_PER_TYPE = 6;
const EXAMPLES_PER_FIELD = 3;

/** Markup that affects how a field should be converted. */
const FEATURES: [string, RegExp][] = [
  ["html_tag", /<[a-z][^>]*>/i],
  ["line_break", /<br\s*\/?>|<div>/i],
  ["bold", /<(b|strong)\b/i],
  ["italic", /<(i|em)\b/i],
  ["list", /<(ul|ol)\b/i],
  ["entity", /&[a-z]+;|&#\d+;/i],
  ["cloze", /\{\{c\d+::/],
  ["sound", /\[sound:/],
  ["image", /<img\b/i],
  ["furigana", /\S\[[^\]\s]+\]/],
  ["ruby", /<ruby\b/i],
  ["link", /<a\b/i],
  ["style_or_class", /\s(style|class)=/i],
];

const truncate = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function buildReport(col: AnkiCollection) {
  const deckName = new Map(col.decks.map((d) => [d.id, d.name]));
  const typeById = new Map(col.noteTypes.map((t) => [t.id, t]));
  const notesByType = new Map<string, typeof col.notes>();
  for (const n of col.notes) notesByType.set(n.typeId, [...(notesByType.get(n.typeId) ?? []), n]);
  const cardsByNote = new Map<string, typeof col.cards>();
  for (const c of col.cards) cardsByNote.set(c.noteId, [...(cardsByNote.get(c.noteId) ?? []), c]);

  const deckCounts = new Map<string, { cards: number; notes: Set<string> }>();
  for (const c of col.cards) {
    const name = deckName.get(c.deckId) ?? `(missing deck ${c.deckId})`;
    const entry = deckCounts.get(name) ?? { cards: 0, notes: new Set() };
    entry.cards++;
    entry.notes.add(c.noteId);
    deckCounts.set(name, entry);
  }
  // Parent decks that only hold sub-decks still belong in the tree.
  for (const name of [...deckCounts.keys()]) {
    const parts = name.split("::");
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join("::");
      if (!deckCounts.has(parent)) deckCounts.set(parent, { cards: 0, notes: new Set() });
    }
  }

  const tagCounts = new Map<string, number>();
  for (const n of col.notes) for (const t of n.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);

  const noteTypes = col.noteTypes
    .filter((t) => notesByType.has(t.id))
    .map((t) => {
      const notes = notesByType.get(t.id)!;
      const cards = notes.flatMap((n) => cardsByNote.get(n.id) ?? []);
      return {
        name: t.name,
        kind: t.kind,
        notes: notes.length,
        cards: cards.length,
        templates: t.templates.map((tpl, ord) => ({
          name: tpl.name,
          front: tpl.front,
          back: tpl.back,
          cards: cards.filter((c) => t.kind === "cloze" || c.ord === ord).length,
        })),
        decks: [...new Set(cards.map((c) => deckName.get(c.deckId)))].sort(),
        fields: t.fields.map((name, i) => {
          const values = notes.map((n) => n.fields[i] ?? "");
          const filled = values.filter((v) => v.trim() !== "");
          return {
            name,
            filled: filled.length,
            fill_rate: Math.round((filled.length / notes.length) * 100) / 100,
            max_length: Math.max(0, ...values.map((v) => v.length)),
            features: Object.fromEntries(
              FEATURES.map(([key, re]) => [key, filled.filter((v) => re.test(v)).length]).filter(([, n]) => n),
            ),
            examples: filled.slice(0, EXAMPLES_PER_FIELD).map((v) => truncate(v)),
          };
        }),
      };
    });

  return {
    format: col.format,
    totals: { decks: deckCounts.size, note_types: noteTypes.length, notes: col.notes.length, cards: col.cards.length },
    media_files: col.mediaFiles,
    decks: [...deckCounts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, { cards, notes }]) => ({ name, depth: name.split("::").length, cards, notes: notes.size })),
    note_types: noteTypes,
    tags: Object.fromEntries([...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50)),
    unused_note_types: col.noteTypes.filter((t) => !notesByType.has(t.id)).map((t) => t.name),
    // Keeps the type lookup honest if a note references a type that isn't in the export.
    notes_with_unknown_type: col.notes.filter((n) => !typeById.has(n.typeId)).length,
  };
}

/** A few complete notes per note type: the first, the last and some spread between. */
export function buildSample(col: AnkiCollection) {
  const deckName = new Map(col.decks.map((d) => [d.id, d.name]));
  return col.noteTypes.flatMap((t) => {
    const notes = col.notes.filter((n) => n.typeId === t.id);
    if (notes.length === 0) return [];
    const step = Math.max(1, Math.floor(notes.length / SAMPLES_PER_TYPE));
    const picked = [...new Set([...notes.filter((_, i) => i % step === 0).slice(0, SAMPLES_PER_TYPE - 1), notes.at(-1)!])];
    return [
      {
        note_type: t.name,
        kind: t.kind,
        notes: picked.map((n) => {
          const cards = col.cards.filter((c) => c.noteId === n.id);
          return {
            id: n.id,
            guid: n.guid,
            fields: Object.fromEntries(t.fields.map((name, i) => [name, n.fields[i] ?? ""])),
            tags: n.tags,
            cards: cards.map((c) => ({
              template: t.kind === "cloze" ? `cloze ${c.ord + 1}` : (t.templates[c.ord]?.name ?? `#${c.ord}`),
              deck: deckName.get(c.deckId),
            })),
          };
        }),
      },
    ];
  });
}

/** Every note with its deck(s), for checking the whole collection by eye. */
export function buildNotes(col: AnkiCollection) {
  const deckName = new Map(col.decks.map((d) => [d.id, d.name]));
  const typeById = new Map(col.noteTypes.map((t) => [t.id, t]));
  const decksByNote = new Map<string, Set<string>>();
  for (const c of col.cards) {
    const set = decksByNote.get(c.noteId) ?? new Set();
    set.add(deckName.get(c.deckId) ?? c.deckId);
    decksByNote.set(c.noteId, set);
  }
  return col.notes
    .map((n) => {
      const type = typeById.get(n.typeId);
      return {
        deck: [...(decksByNote.get(n.id) ?? [])].join(" | "),
        note_type: type?.name,
        fields: Object.fromEntries((type?.fields ?? []).map((name, i) => [name, n.fields[i] ?? ""])),
        tags: n.tags,
      };
    })
    .sort((a, b) => a.deck.localeCompare(b.deck));
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: npm run anki:inspect -- path/to/export.apkg");
    process.exit(1);
  }
  const col = await readAnkiExport(file);
  const report = buildReport(col);
  const stem = path.basename(file).replace(/\.(apkg|colpkg)$/i, "");
  await mkdir(DIR, { recursive: true });
  const reportPath = path.join(DIR, `${stem}-report.json`);
  const samplePath = path.join(DIR, `${stem}-sample.json`);
  const notesPath = path.join(DIR, `${stem}-notes.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  await writeFile(samplePath, JSON.stringify(buildSample(col), null, 2));
  await writeFile(notesPath, JSON.stringify(buildNotes(col), null, 2));

  console.log(`${file}: ${report.totals.notes} notes, ${report.totals.cards} cards (${col.format})\n`);
  console.log("Decks:");
  for (const d of report.decks) {
    const own = d.cards ? `  (${d.cards} cards)` : "";
    console.log(`  ${"  ".repeat(d.depth - 1)}${d.name.split("::").at(-1)}${own}`);
  }
  console.log("\nNote types:");
  for (const t of report.note_types) {
    console.log(`  ${t.name} [${t.kind}]: ${t.notes} notes → ${t.cards} cards`);
    console.log(`    fields: ${t.fields.map((f) => `${f.name} (${Math.round(f.fill_rate * 100)}%)`).join(", ")}`);
    console.log(`    cards:  ${t.templates.map((tpl) => tpl.name).join(", ")}`);
  }
  if (report.media_files) console.log(`\nMedia files in the export: ${report.media_files} (not imported)`);
  console.log(`\nWrote ${reportPath}, ${samplePath} and ${notesPath} (every note).`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
