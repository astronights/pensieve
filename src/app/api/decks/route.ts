import { getDb } from "@/db";
import { handle } from "@/lib/http";
import { listDecks } from "@/lib/queue";

export async function GET() {
  return handle(async () => ({ decks: await listDecks(getDb()) }));
}
