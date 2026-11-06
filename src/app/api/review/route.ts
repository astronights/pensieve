import { getDb } from "@/db";
import { handle, readJson } from "@/lib/http";
import { listDecks, toCounts } from "@/lib/queue";
import { applyReview, parseReviewInput } from "@/lib/review";
import { answerTime } from "@/lib/sync";

export async function POST(req: Request) {
  return handle(async () => {
    const db = getDb();
    const body = await readJson(req);
    // `at`: when the answer was given on the phone, so an answer that reached the server but whose
    // reply was lost isn't counted twice when the phone later syncs it from its offline queue.
    const result = await applyReview(db, parseReviewInput(body), answerTime((body as { at?: unknown }).at));
    // Fresh counts let the study screen correct its header after a background save. They are for
    // the deck being studied (`deck`), which may be the parent of the card's own sub-deck.
    const studied = (body as { deck?: unknown }).deck;
    const [deck] = await listDecks(db, typeof studied === "string" && studied ? studied : result.deck);
    return { ...result, counts: deck && toCounts(deck) };
  });
}
