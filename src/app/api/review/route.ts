import { getDb } from "@/db";
import { handle, readJson } from "@/lib/http";
import { listDecks, toCounts } from "@/lib/queue";
import { applyReview, parseReviewInput } from "@/lib/review";

export async function POST(req: Request) {
  return handle(async () => {
    const db = getDb();
    const body = await readJson(req);
    const result = await applyReview(db, parseReviewInput(body));
    // Fresh counts let the study screen correct its header after a background save. They are for
    // the deck being studied (`deck`), which may be the parent of the card's own sub-deck.
    const studied = (body as { deck?: unknown }).deck;
    const [deck] = await listDecks(db, typeof studied === "string" && studied ? studied : result.deck);
    return { ...result, counts: deck && toCounts(deck) };
  });
}
