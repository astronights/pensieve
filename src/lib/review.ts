import { eq, sql } from "drizzle-orm";
import type { Grade } from "ts-fsrs";
import type { DB } from "@/db";
import { cards, cardState, decks, reviewLog } from "@/db/schema";
import { badRequest, notFound } from "./errors";
import { schedule } from "./fsrs";
import { getSettings } from "./settings";

export const ADD_TO_REVIEW_DELAY_MS = 24 * 60 * 60 * 1000;

export type ReviewInput =
  | { card_id: string; rating: 1 | 2 | 3 | 4 }
  | { card_id: string; action: "add_to_review" }
  | { card_id: string; action: "bookmark"; value: boolean };

export function parseReviewInput(body: unknown): ReviewInput {
  if (!body || typeof body !== "object") throw badRequest("Expected a JSON object");
  const b = body as Record<string, unknown>;
  if (typeof b.card_id !== "string" || !b.card_id) throw badRequest("card_id is required");
  if ("rating" in b) {
    if (b.rating !== 1 && b.rating !== 2 && b.rating !== 3 && b.rating !== 4) {
      throw badRequest("rating must be 1 (Again), 2 (Hard), 3 (Good) or 4 (Easy)");
    }
    return { card_id: b.card_id, rating: b.rating };
  }
  if (b.action === "add_to_review") return { card_id: b.card_id, action: "add_to_review" };
  if (b.action === "bookmark") {
    if (typeof b.value !== "boolean") throw badRequest("bookmark requires a boolean value");
    return { card_id: b.card_id, action: "bookmark", value: b.value };
  }
  throw badRequest("Provide rating (1-4) or action ('add_to_review' | 'bookmark')");
}

export type ReviewResult = {
  card_id: string;
  /** Whether FSRS scheduled the card (false for a plain "seen" mark in a browse deck). */
  scheduled: boolean;
  state: (typeof cardState.$inferSelect)["state"];
  due: Date;
  in_review_queue: boolean;
  bookmarked: boolean;
};

const toResult = (s: typeof cardState.$inferSelect, scheduled: boolean): ReviewResult => ({
  card_id: s.cardId,
  scheduled,
  state: s.state,
  due: s.due,
  in_review_queue: s.inReviewQueue,
  bookmarked: s.bookmarked,
});

export async function applyReview(db: DB, input: ReviewInput, now = new Date()): Promise<ReviewResult> {
  const [found] = await db
    .select({ kind: decks.kind, state: cardState })
    .from(cards)
    .innerJoin(decks, eq(decks.id, cards.deck))
    .leftJoin(cardState, eq(cardState.cardId, cards.id))
    .where(eq(cards.id, input.card_id))
    .limit(1);
  if (!found) throw notFound(`Card not found: ${input.card_id}`);
  const existing = found.state;

  if ("action" in input && input.action === "bookmark") {
    const [row] = await db
      .insert(cardState)
      .values({ cardId: input.card_id, due: now, bookmarked: input.value })
      .onConflictDoUpdate({ target: cardState.cardId, set: { bookmarked: input.value } })
      .returning();
    return toResult(row, false);
  }

  if ("action" in input) {
    // A never-reviewed card enters FSRS as a new card due tomorrow, so it doesn't
    // reappear immediately; an already-scheduled card keeps its due date.
    const firstDue = new Date(now.getTime() + ADD_TO_REVIEW_DELAY_MS);
    const [row] = await db
      .insert(cardState)
      .values({ cardId: input.card_id, due: firstDue, inReviewQueue: true })
      .onConflictDoUpdate({
        target: cardState.cardId,
        set: {
          inReviewQueue: true,
          due: sql`case when ${cardState.reps} = 0 then ${firstDue.toISOString()}::timestamptz else ${cardState.due} end`,
        },
      })
      .returning();
    return toResult(row, false);
  }

  const inFsrs = found.kind === "srs" || existing?.inReviewQueue === true || input.rating === 1;
  if (!inFsrs) {
    // Browse deck, not queued, rated Hard/Good/Easy: just remember that it was seen.
    const [row] = await db
      .insert(cardState)
      .values({ cardId: input.card_id, due: now, lastReview: now })
      .onConflictDoUpdate({ target: cardState.cardId, set: { lastReview: now } })
      .returning();
    return toResult(row, false);
  }

  const { desired_retention } = await getSettings(db);
  const next = schedule(existing, input.rating as Grade, now, desired_retention);
  const values = {
    ...next,
    inReviewQueue: found.kind === "browse" ? true : (existing?.inReviewQueue ?? false),
  };

  const row = await db.transaction(async (tx) => {
    const [saved] = await tx
      .insert(cardState)
      .values({ cardId: input.card_id, ...values })
      .onConflictDoUpdate({ target: cardState.cardId, set: values })
      .returning();
    await tx.insert(reviewLog).values({
      cardId: input.card_id,
      reviewedAt: now,
      rating: input.rating,
      stateBefore: existing?.state ?? "new",
      dueBefore: existing?.due ?? null,
      dueAfter: next.due,
      stability: next.stability,
      difficulty: next.difficulty,
    });
    return saved;
  });
  return toResult(row, true);
}
