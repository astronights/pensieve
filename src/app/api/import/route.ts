import { getDb } from "@/db";
import { handle, readJson } from "@/lib/http";
import { importCards, parseImportPayload } from "@/lib/import";

export async function POST(req: Request) {
  return handle(async () => importCards(getDb(), parseImportPayload(await readJson(req))));
}
