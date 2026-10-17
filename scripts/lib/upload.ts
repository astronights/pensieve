/**
 * Shared by the content converters: `--upload` flag parsing and chunked import into the app.
 *
 * The URL and passcode come from flags or env (.env.local is read by the caller):
 *   --url https://your-app.vercel.app   (or PENSIEVE_URL)
 *   --passcode …                        (or APP_PASSCODE)
 */
import type { ImportPayload } from "../../src/lib/import";

const CHUNK = 400; // cards per request; keeps each request well under Vercel's 4.5 MB body limit

export type UploadArgs = { upload: boolean; url: string; passcode: string };

/** Parses `--upload --url … --passcode …`; any other flag is an error unless listed in `extra`. */
export function parseUploadArgs(argv: string[], extra: string[] = []) {
  const args: UploadArgs = {
    upload: false,
    url: process.env.PENSIEVE_URL ?? "",
    passcode: process.env.APP_PASSCODE ?? "",
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--upload") args.upload = true;
    else if (a === "--url") args.url = argv[++i] ?? "";
    else if (a === "--passcode") args.passcode = argv[++i] ?? "";
    else if (a.startsWith("--") && !extra.includes(a)) throw new Error(`Unknown argument: ${a}`);
    else rest.push(a);
  }
  return { args, rest };
}

export async function upload(payload: ImportPayload, { url, passcode }: UploadArgs) {
  if (!url || !passcode) throw new Error("--upload needs --url/PENSIEVE_URL and --passcode/APP_PASSCODE");
  const endpoint = new URL("/api/import", url).toString();
  console.log(`Importing into ${url} …`);
  for (let i = 0; i < payload.cards.length; i += CHUNK) {
    const cards = payload.cards.slice(i, i + CHUNK);
    // Decks go with every chunk (idempotent), so any chunk can be retried on its own.
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${passcode}` },
      body: JSON.stringify({ decks: payload.decks, cards }),
    });
    const body = await res.text();
    if (!res.ok)
      throw new Error(`Import failed at cards ${i + 1}-${i + cards.length}: HTTP ${res.status} ${body.slice(0, 300)}`);
    console.log(`  imported ${Math.min(i + CHUNK, payload.cards.length)}/${payload.cards.length}`);
  }
  console.log("Done. Re-running is safe: content is updated, study progress is kept.");
}
