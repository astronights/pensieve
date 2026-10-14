import { getDb } from "@/db";
import { handle, readJson } from "@/lib/http";
import { listDecks } from "@/lib/queue";
import { applyReview, parseReviewInput } from "@/lib/review";

export async function POST(req: Request) {
  return handle(async () => {
    const db = getDb();
    const result = await applyReview(db, parseReviewInput(await readJson(req)));
    // Fresh deck counts let the study screen correct its header after a background save.
    const [deck] = await listDecks(db, new Date(), result.deck);
    return { ...result, counts: deck && { due: deck.due, new: deck.new, unseen: deck.unseen } };
  });
}
