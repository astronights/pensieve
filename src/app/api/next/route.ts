import type { NextRequest } from "next/server";
import { getDb } from "@/db";
import { badRequest } from "@/lib/errors";
import { handle } from "@/lib/http";
import { nextCard } from "@/lib/queue";

export async function GET(req: NextRequest) {
  return handle(async () => {
    const params = req.nextUrl.searchParams;
    const deck = params.get("deck");
    if (!deck) throw badRequest("deck is required");
    return nextCard(getDb(), deck, {
      category: params.get("category"),
      season: params.get("season"),
      exclude: params.get("exclude"),
    });
  });
}
