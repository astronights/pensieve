/**
 * Converts the scraped ZQL question bank into Pensieve cards and (optionally) imports them.
 *
 *   npm run zql:convert                 # dry run: writes content/zql/cards.json + convert-report.json
 *   npm run zql:convert -- --upload     # also imports into the app (re-running only updates)
 *
 * --upload needs the app URL and passcode, from flags or env (.env.local is read):
 *   --url https://your-app.vercel.app   (or PENSIEVE_URL)
 *   --passcode …                        (or APP_PASSCODE)
 *
 * Input: content/zql/questions.json from `npm run zql:scrape`.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "dotenv";
import type { ImportPayload } from "../../src/lib/import";
import { convertAll, type RawQuestion } from "./transform";

config({ path: ".env.local", quiet: true });

const DIR = path.join("content", "zql");
const CHUNK = 400; // cards per request; keeps each request well under Vercel's 4.5 MB body limit

function parseArgs(argv: string[]) {
  const args = { upload: false, url: process.env.PENSIEVE_URL ?? "", passcode: process.env.APP_PASSCODE ?? "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--upload") args.upload = true;
    else if (a === "--url") args.url = argv[++i] ?? "";
    else if (a === "--passcode") args.passcode = argv[++i] ?? "";
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

async function upload(payload: ImportPayload, baseUrl: string, passcode: string) {
  const endpoint = new URL("/api/import", baseUrl).toString();
  for (let i = 0; i < payload.cards.length; i += CHUNK) {
    const cards = payload.cards.slice(i, i + CHUNK);
    // Decks go with every chunk (idempotent), so any chunk can be retried on its own.
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${passcode}` },
      body: JSON.stringify({ decks: payload.decks, cards }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`Import failed at cards ${i + 1}-${i + cards.length}: HTTP ${res.status} ${body}`);
    console.log(`  imported ${Math.min(i + CHUNK, payload.cards.length)}/${payload.cards.length}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const records = JSON.parse(await readFile(path.join(DIR, "questions.json"), "utf8")) as RawQuestion[];
  const { payload, issues, stats } = convertAll(records);

  await writeFile(path.join(DIR, "cards.json"), `${JSON.stringify(payload, null, 2)}\n`);
  await writeFile(
    path.join(DIR, "convert-report.json"),
    `${JSON.stringify({ ...stats, issues }, null, 2)}\n`,
  );

  console.log(`Converted ${stats.cards} of ${stats.records} questions into ${payload.decks.length} decks:`);
  for (const [deck, n] of Object.entries(stats.byDeck)) console.log(`  ${deck.padEnd(14)} ${n}`);
  console.log(`Media: ${Object.entries(stats.media).map(([k, v]) => `${v} ${k}`).join(", ") || "none"}`);
  if (issues.length) console.log(`⚠ ${issues.length} questions skipped (see convert-report.json)`);
  if (stats.droppedMedia.length) console.log(`⚠ ${stats.droppedMedia.length} media links couldn't be used (see report)`);
  if (stats.unsplitLongAnswers.length) {
    console.log(`ℹ ${stats.unsplitLongAnswers.length} long answers had no ";" to split on (kept whole; see report)`);
  }
  console.log(`Wrote ${DIR}/cards.json and ${DIR}/convert-report.json`);

  if (!args.upload) {
    console.log("Dry run only. Re-run with --upload to import.");
    return;
  }
  if (!args.url || !args.passcode) throw new Error("--upload needs --url/PENSIEVE_URL and --passcode/APP_PASSCODE");
  console.log(`Importing into ${args.url} …`);
  await upload(payload, args.url, args.passcode);
  console.log("Done. Re-running is safe: content is updated, study progress is kept.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
