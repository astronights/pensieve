import { handle, readJson } from "@/lib/http";
import { parseTranscribeInput, transcribe } from "@/lib/transcribe";

/** POST {audio: base64, mime_type, languages?} → {text}: one spoken answer or command. */
export async function POST(req: Request) {
  return handle(async () => ({ text: await transcribe(parseTranscribeInput(await readJson(req))) }));
}
