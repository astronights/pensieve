import { getDb } from "@/db";
import { handle, readJson } from "@/lib/http";
import { applyOfflineAnswers, buildSnapshot, parseOfflineAnswers } from "@/lib/sync";

/** GET /api/sync?have=<cardsVersion> → the offline copy (cards left out if the phone has them). */
export async function GET(req: Request) {
  return handle(async () => buildSnapshot(getDb(), new URL(req.url).searchParams.get("have")));
}

/** POST /api/sync {answers: [{card_id, answer, at}]} → applies answers given offline, in order. */
export async function POST(req: Request) {
  return handle(async () => applyOfflineAnswers(getDb(), parseOfflineAnswers(await readJson(req))));
}
