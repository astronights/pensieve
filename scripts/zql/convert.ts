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
import { parseUploadArgs, upload } from "../lib/upload";
import { convertAll, type RawQuestion } from "./transform";

config({ path: ".env.local", quiet: true });

const DIR = path.join("content", "zql");

async function main() {
  const { args, rest } = parseUploadArgs(process.argv.slice(2));
  if (rest.length) throw new Error(`Unknown argument: ${rest[0]}`);
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
  await upload(payload, args);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
