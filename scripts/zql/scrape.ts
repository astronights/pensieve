/**
 * Scrapes the ZQL Question Bank and writes, under content/zql/ (gitignored):
 *   questions.json  every raw record, untouched
 *   report.json     field-by-field description of the data (share this)
 *   sample.json     a representative set of full records (share this)
 *
 * The bank is a Google Apps Script web app with no public API: the page fetches questions via
 * google.script.run inside Google's sandboxed iframe, so we load it in a real browser and read
 * the in-page `questions` array once it's populated.
 *
 * Usage (on your machine; needs Chromium once: `npx playwright install chromium`):
 *   npm run zql:scrape
 *   npm run zql:scrape -- --headed          # watch the browser
 *   npm run zql:scrape -- --timeout 180     # seconds to wait for the data (default 120)
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Page } from "@playwright/test";
import { analyze, pickSample, type RawQuestion } from "./analyze";

const DEFAULT_URL =
  "https://script.google.com/macros/s/AKfycbzaPyUGIeNRzmJTmZPUh7m8MwurL0aalxa2EH-p7Nip1zmYbUy6K3VgzgX3sSg2f-gqWA/exec";
const OUT_DIR = path.join("content", "zql");

function parseArgs(argv: string[]) {
  const args = { url: DEFAULT_URL, headed: false, timeout: 120 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--headed") args.headed = true;
    else if (a === "--timeout") args.timeout = Number(argv[++i]);
    else if (a === "--url") args.url = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!Number.isFinite(args.timeout) || args.timeout <= 0) throw new Error("--timeout must be a positive number");
  return args;
}

const log = (msg: string) => console.log(`${new Date().toISOString().slice(11, 19)}  ${msg}`);

// Evaluated as page source (not via globalThis) so a top-level `let`/`const questions` is visible too;
// only `var` declarations end up on globalThis.
const QUESTIONS_LENGTH = "typeof questions !== 'undefined' && Array.isArray(questions) ? questions.length : null";
const QUESTIONS = "questions";

/** Checks every frame (the data lives in a nested Google iframe) until `questions` is filled. */
async function waitForQuestions(page: Page, timeoutSeconds: number): Promise<RawQuestion[] | null> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (let attempt = 1; Date.now() < deadline; attempt++) {
    for (const frame of page.frames()) {
      try {
        const length = (await frame.evaluate(QUESTIONS_LENGTH)) as number | null;
        if (length) {
          log(`Found ${length} questions in ${frame.url() || "(frame)"}`);
          return (await frame.evaluate(QUESTIONS)) as RawQuestion[];
        }
      } catch {
        // Frame is cross-origin-restricted, navigating or detached; try again next round.
      }
    }
    if (attempt % 5 === 1) log(`Waiting for question data… (${page.frames().length} frames loaded)`);
    await page.waitForTimeout(2000);
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(OUT_DIR, { recursive: true });
  log(`Opening ${args.url}`);

  const browser = await chromium.launch({
    headless: !args.headed,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
  });
  try {
    const page = await browser.newPage();
    await page.goto(args.url, { waitUntil: "load", timeout: 60_000 });
    const questions = await waitForQuestions(page, args.timeout);

    if (!questions) {
      const debugDir = path.join(OUT_DIR, "debug");
      await mkdir(debugDir, { recursive: true });
      for (const [i, frame] of page.frames().entries()) {
        await writeFile(path.join(debugDir, `frame-${i}.html`), await frame.content().catch(() => ""));
      }
      throw new Error(
        `No question data after ${args.timeout}s. Frame snapshots saved to ${debugDir}/ (share these to debug).`,
      );
    }

    const write = (name: string, data: unknown) =>
      writeFile(path.join(OUT_DIR, name), `${JSON.stringify(data, null, 2)}\n`, "utf8");
    const report = analyze(questions);
    const sample = pickSample(questions);
    await write("questions.json", questions);
    await write("report.json", report);
    await write("sample.json", sample);

    log(`Saved ${questions.length} questions → ${OUT_DIR}/questions.json`);
    log(`Saved field report → ${OUT_DIR}/report.json`);
    log(`Saved ${sample.length} sample records → ${OUT_DIR}/sample.json`);
    log("Share report.json and sample.json to plan the import.");
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
