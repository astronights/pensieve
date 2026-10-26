import { getDb } from "@/db";
import { handle } from "@/lib/http";
import { searchCards } from "@/lib/search";

/** GET /api/search?q=words "or a phrase" → {total, cards}: cards containing every keyword. */
export async function GET(req: Request) {
  return handle(async () => searchCards(getDb(), new URL(req.url).searchParams.get("q") ?? ""));
}
