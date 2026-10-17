/**
 * Turns an Anki collection into Pensieve decks and cards.
 *
 * Anki layout: "<Language> - <Book/Level>::<Topic>", e.g. "Russian - Между нами Unit 1::Clothing".
 * Pensieve layout: one top-level deck per language, one sub-deck per book level (the unit,
 * chapter or level number), with the topic kept as the card's category.
 *
 *   Russian - Между нами Unit 1::Clothing      → Russian › Unit 1   (category "Clothing")
 *   Swedish - Complete Swedish - Chapter 3::…  → Swedish › Chapter 3
 *   Mandarin - HSK1::Day 1 - Ordering Drinks   → Mandarin › HSK 1   (category "Day 1 - Ordering Drinks")
 *
 * Card ids sort in study order (level, then topic, then the order the notes were added in Anki),
 * so new cards come up topic by topic as they did in Anki.
 */
import type { ImportCard, ImportDeck, ImportPayload } from "../../src/lib/import";
import type { AnkiCollection } from "./read";

/** Per-language fixes: `meanings` maps a card's front to an English meaning added to its back. */
export type Fixes = Record<string, { meanings?: Record<string, string> }>;

export type ConvertIssue = { deck: string; front: string; problem: string };

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Anki fields are HTML: decode entities, turn line breaks into newlines and drop other tags. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>|<\/div>\s*<div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
      if (code[0] === "#") {
        const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      return NAMED_ENTITIES[code.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .trim();
}

/** Card text is rendered as Markdown; keep vocabulary literal (no accidental lists, emphasis or links). */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/([\\`*_[\]<>|])/g, "\\$1")
    .replace(/^(\s*)([#>+-])(\s)/gm, "$1\\$2$3")
    .replace(/^(\s*\d+)([.)])(\s)/gm, "$1\\$2$3");
}

/** "Между нами Unit 1" → "Unit 1"; "Complete Swedish - Chapter 3" → "Chapter 3"; "HSK1" → "HSK 1". */
export function levelName(rest: string): string {
  const numbered = rest.match(/\b(Unit|Chapter|Lesson|Part|Book|Level)\s*(\d+)\s*$/i);
  if (numbered) return `${numbered[1][0].toUpperCase()}${numbered[1].slice(1).toLowerCase()} ${Number(numbered[2])}`;
  return rest.replace(/([A-Za-z])(\d+)$/, "$1 $2").trim();
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "x";

const pad = (n: number, width: number) => String(n).padStart(width, "0");

/** Sorts "Day 2" before "Day 10" and "Unit 2" before "Unit 10". */
const natural = new Intl.Collator("en", { numeric: true, sensitivity: "base" }).compare;

type Placement = { language: string; level: string; topic: string };

/** Splits an Anki deck name into language, level and topic, or explains why it can't. */
export function placeDeck(name: string): Placement | string {
  const parts = name.split("::");
  if (parts.length !== 2) return `expected "<Language> - <Level>::<Topic>", got ${parts.length} level(s)`;
  const [top, topic] = parts;
  const dash = top.indexOf(" - ");
  if (dash < 0) return `top-level deck "${top}" has no " - " between language and level`;
  return { language: top.slice(0, dash).trim(), level: levelName(top.slice(dash + 3)), topic: topic.trim() };
}

export function convertCollection(col: AnkiCollection, fixes: Fixes = {}) {
  const issues: ConvertIssue[] = [];
  const deckName = new Map(col.decks.map((d) => [d.id, d.name]));
  const typeById = new Map(col.noteTypes.map((t) => [t.id, t]));
  const deckOfNote = new Map(col.cards.map((c) => [c.noteId, deckName.get(c.deckId) ?? c.deckId]));

  type Row = Placement & { noteOrder: number; front: string; back: string; raw: Record<string, unknown> };
  const rows: Row[] = [];
  col.notes.forEach((note, noteOrder) => {
    const deck = deckOfNote.get(note.id) ?? "(no cards)";
    const type = typeById.get(note.typeId);
    const field = (name: string) => note.fields[type?.fields.indexOf(name) ?? -1] ?? "";
    const front = htmlToText(field("Front"));
    let back = htmlToText(field("Back"));
    const place = placeDeck(deck);
    if (typeof place === "string") return void issues.push({ deck, front, problem: place });
    if (type?.name !== "Basic")
      return void issues.push({ deck, front, problem: `note type "${type?.name}" isn't handled` });
    if (!front || !back) return void issues.push({ deck, front, problem: "empty front or back" });

    const meanings = fixes[place.language]?.meanings;
    if (meanings) {
      const meaning = meanings[front];
      if (!meaning) return void issues.push({ deck, front, problem: "no meaning in the fixes file" });
      back = `${back}\n${meaning}`;
    }
    rows.push({
      ...place,
      noteOrder,
      front,
      back,
      raw: {
        guid: note.guid,
        deck,
        fields: Object.fromEntries((type?.fields ?? []).map((f, i) => [f, note.fields[i]])),
        tags: note.tags,
      },
    });
  });

  // Number levels per language and topics per level in natural order, for sortable ids.
  const levels = new Map<string, string[]>();
  const topics = new Map<string, string[]>();
  for (const r of rows) {
    levels.set(r.language, [...new Set([...(levels.get(r.language) ?? []), r.level])].sort(natural));
    const key = `${r.language}\u0000${r.level}`;
    topics.set(key, [...new Set([...(topics.get(key) ?? []), r.topic])].sort(natural));
  }

  const decks: ImportDeck[] = [];
  for (const [language, langLevels] of [...levels.entries()].sort(([a], [b]) => natural(a, b))) {
    const parent = `anki:${slug(language)}`;
    decks.push({ id: parent, name: language, kind: "srs", parent: null });
    for (const level of langLevels) decks.push({ id: `${parent}:${slug(level)}`, name: level, parent });
  }

  const cards: ImportCard[] = rows
    .map((r) => {
      const lang = slug(r.language);
      const levelIdx = levels.get(r.language)!.indexOf(r.level) + 1;
      const topicIdx = topics.get(`${r.language}\u0000${r.level}`)!.indexOf(r.topic) + 1;
      return {
        id: `anki:${lang}:${pad(levelIdx, 2)}:${pad(topicIdx, 2)}:${pad(r.noteOrder, 4)}`,
        deck: `anki:${lang}:${slug(r.level)}`,
        front: escapeMarkdown(r.front),
        back: escapeMarkdown(r.back),
        tags: [],
        category: r.topic,
        media: [],
        meta: { raw: r.raw },
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  const byDeck: Record<string, number> = {};
  for (const c of cards) byDeck[c.deck] = (byDeck[c.deck] ?? 0) + 1;
  const payload: ImportPayload = { decks, cards };
  return { payload, issues, stats: { notes: col.notes.length, cards: cards.length, byDeck } };
}
