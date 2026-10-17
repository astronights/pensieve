/**
 * Converts an Anki export into Pensieve decks and cards and (optionally) imports them.
 *
 *   npm run anki:convert -- path/to/export.apkg            # dry run: writes content/anki/cards.json,
 *                                                          #   cards-preview.csv and convert-report.json
 *   npm run anki:convert -- path/to/export.apkg --upload   # also imports into the app
 *
 * --upload needs --url/PENSIEVE_URL and --passcode/APP_PASSCODE (.env.local is read).
 * Re-running updates card content and never resets study progress. See transform.ts for the mapping;
 * a word that appears more than once in a language is merged into one card.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "dotenv";
import { parseUploadArgs, upload } from "../lib/upload";
import { readAnkiExport } from "./read";
import { convertCollection, type Fixes } from "./transform";

config({ path: ".env.local", quiet: true });

const DIR = path.join("content", "anki");
const FIXES_DIR = path.join(__dirname, "fixes");

/** fixes/<language>-meanings.json → { Language: { meanings } } */
export async function loadFixes(): Promise<Fixes> {
  const mandarin = JSON.parse(await readFile(path.join(FIXES_DIR, "mandarin-meanings.json"), "utf8")) as Record<
    string,
    string
  >;
  delete mandarin._about;
  return { Mandarin: { meanings: mandarin } };
}

const csvCell = (s: string) => `"${s.replace(/"/g, '""')}"`;

async function main() {
  const { args, rest } = parseUploadArgs(process.argv.slice(2));
  const [file] = rest;
  if (!file || rest.length > 1) throw new Error("Usage: npm run anki:convert -- path/to/export.apkg [--upload]");

  const { payload, issues, stats } = convertCollection(await readAnkiExport(file), await loadFixes());
  await mkdir(DIR, { recursive: true });
  await writeFile(path.join(DIR, "cards.json"), `${JSON.stringify(payload, null, 2)}\n`);
  await writeFile(path.join(DIR, "convert-report.json"), `${JSON.stringify({ ...stats, issues }, null, 2)}\n`);
  // Opens in Excel/Sheets for checking every card before uploading (BOM so Excel reads UTF-8).
  const deckName = new Map(payload.decks.map((d) => [d.id, d]));
  const csv = [
    ["deck", "sub-deck", "category", "front", "back"].join(","),
    ...payload.cards.map((c) => {
      const sub = deckName.get(c.deck)!;
      const parent = sub.parent ? deckName.get(sub.parent)!.name : "";
      return [parent, sub.name, c.category ?? "", c.front, c.back.replace(/\n/g, " / ")].map(csvCell).join(",");
    }),
  ].join("\r\n");
  await writeFile(path.join(DIR, "cards-preview.csv"), `\uFEFF${csv}\r\n`);

  console.log(`Converted ${stats.cards} of ${stats.notes} notes:`);
  for (const d of payload.decks) {
    const n = d.parent
      ? stats.byDeck[d.id]
      : Object.entries(stats.byDeck)
          .filter(([id]) => id.startsWith(`${d.id}:`))
          .reduce((s, [, v]) => s + v, 0);
    console.log(`  ${d.parent ? "  " : ""}${d.name.padEnd(d.parent ? 14 : 16)} ${n}`);
  }
  if (stats.merged.length) {
    console.log(`ℹ ${stats.merged.length} words appeared more than once and were merged into one card each:`);
    for (const m of stats.merged) console.log(`    ${m.front}  →  ${m.back}`);
  }
  if (issues.length) console.log(`⚠ ${issues.length} notes skipped (see convert-report.json)`);
  console.log(`Wrote ${DIR}/cards.json, cards-preview.csv and convert-report.json`);

  if (!args.upload) {
    console.log("Dry run only. Check cards-preview.csv, then re-run with --upload to import.");
    return;
  }
  await upload(payload, args);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
