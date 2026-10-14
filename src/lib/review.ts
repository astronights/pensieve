import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import { type Answer, cards, cardState, decks, reviewLog } from "@/db/schema";
import { badRequest, notFound } from "./errors";
import { getSettings, goodGap } from "./settings";

export type ReviewInput =
  | { card_id: string; answer: "again" | "good" }
  | { card_id: string; action: "bookmark"; value: boolean };

export function parseReviewInput(body: unknown): ReviewInput {
  if (!body || typeof body !== "object") throw badRequest("Expected a JSON object");
  const b = body as Record<string, unknown>;
  if (typeof b.card_id !== "string" || !b.card_id) throw badRequest("card_id is required");
  if ("answer" in b) {
    if (b.answer !== "again" && b.answer !== "good") throw badRequest("answer must be 'again' or 'good'");
    return { card_id: b.card_id, answer: b.answer };
  }
  if (b.action === "bookmark") {
    if (typeof b.value !== "boolean") throw badRequest("bookmark requires a boolean value");
    return { card_id: b.card_id, action: "bookmark", value: b.value };
  }
  throw badRequest("Provide answer ('again' | 'good') or action 'bookmark'");
}

export type ReviewResult = {
  card_id: string;
  deck: string;
  streak: number;
  /** The answer counter value at which the card comes back; null when it isn't being learned. */
  due_at: number | null;
  learned: boolean;
  bookmarked: boolean;
};

const toResult = (s: typeof cardState.$inferSelect, deck: string): ReviewResult => ({
  card_id: s.cardId,
  deck,
  streak: s.streak,
  due_at: s.dueAt,
  learned: s.learnedAt !== null,
  bookmarked: s.bookmarked,
});

/**
 * Again: the streak resets and the card comes back `again_gap` cards later.
 * Good: the streak grows and the card comes back `good_gap` cards later (doubling each time);
 * at `learned_after` Goods in a row it is learned and leaves the queue.
 * A browse-deck card that isn't being learned only joins the loop on Again; Good ("Next") just
 * marks it seen.
 */
export async function applyReview(db: DB, input: ReviewInput, now = new Date()): Promise<ReviewResult> {
  const [found] = await db
    .select({ deck: decks.id, kind: decks.kind, state: cardState })
    .from(cards)
    .innerJoin(decks, eq(decks.id, cards.deck))
    .leftJoin(cardState, eq(cardState.cardId, cards.id))
    .where(eq(cards.id, input.card_id))
    .limit(1);
  if (!found) throw notFound(`Card not found: ${input.card_id}`);
  const existing = found.state;

  if ("action" in input) {
    const [row] = await db
      .insert(cardState)
      .values({ cardId: input.card_id, bookmarked: input.value })
      .onConflictDoUpdate({ target: cardState.cardId, set: { bookmarked: input.value } })
      .returning();
    return toResult(row, found.deck);
  }

  const settings = await getSettings(db);
  const learning = existing?.dueAt != null;
  const seenOnly = input.answer === "good" && found.kind === "browse" && !learning;
  const kind: Answer = seenOnly ? "seen" : input.answer;

  const row = await db.transaction(async (tx) => {
    // The new log row's id is the current position in the answer count.
    const [log] = await tx
      .insert(reviewLog)
      .values({ cardId: input.card_id, reviewedAt: now, answer: kind })
      .returning({ id: reviewLog.id });

    let values: Partial<typeof cardState.$inferInsert>;
    if (seenOnly) {
      values = { seenAt: now };
    } else if (input.answer === "again") {
      values = { seenAt: now, streak: 0, dueAt: log.id + settings.again_gap, learnedAt: null };
    } else {
      const streak = (existing?.streak ?? 0) + 1;
      values =
        streak >= settings.learned_after
          ? { seenAt: now, streak, dueAt: null, learnedAt: now }
          : { seenAt: now, streak, dueAt: log.id + goodGap(settings, streak) };
    }

    const [saved] = await tx
      .insert(cardState)
      .values({ cardId: input.card_id, ...values })
      .onConflictDoUpdate({ target: cardState.cardId, set: values })
      .returning();
    return saved;
  });
  return toResult(row, found.deck);
}
