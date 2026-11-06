import { and, eq, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { cards, cardState, decks, reviewLog } from "@/db/schema";
import { clientMeta } from "./card-extras";
import { badRequest } from "./errors";
import { applyReview } from "./review";
import { getSettings } from "./settings";
import type { Snapshot, SnapshotCard, SnapshotState } from "./snapshot";

/**
 * A copy of everything the phone needs to study offline. Cards are only sent when they changed
 * since the copy the phone already has (`have`, the `cardsVersion` it got last time); decks,
 * progress and settings always are (they're small).
 */
export async function buildSnapshot(db: DB, have?: string | null): Promise<Snapshot> {
  const [version] = await db
    .select({
      v: sql<string>`count(*)::text || '-' || coalesce(max(${cards.updatedAt})::text, '') || '-' || coalesce(max(${cards.createdAt})::text, '')`,
    })
    .from(cards);
  const cardsVersion = version.v;

  const [deckRows, stateRows, settings, cardRows] = await Promise.all([
    db
      .select({ id: decks.id, name: decks.name, kind: decks.kind, parent: decks.parent, answers: decks.answers })
      .from(decks),
    db.select().from(cardState),
    getSettings(db),
    have === cardsVersion
      ? null
      : db
          .select({
            id: cards.id,
            deck: cards.deck,
            front: cards.front,
            back: cards.back,
            tags: cards.tags,
            category: cards.category,
            media: cards.media,
            meta: cards.meta,
            // The database's own orderings, so the phone breaks ties exactly as the server does.
            order: sql<number>`(row_number() over (order by ${cards.createdAt}, ${cards.id}))::int`,
            idRank: sql<number>`(row_number() over (order by ${cards.id}))::int`,
          })
          .from(cards)
          .orderBy(cards.createdAt, cards.id),
  ]);

  const states: Record<string, SnapshotState> = {};
  for (const s of stateRows) {
    states[s.cardId] = {
      streak: s.streak,
      dueAt: s.dueAt,
      seen: s.seenAt !== null,
      learned: s.learnedAt !== null,
      missed: s.missed,
      bookmarked: s.bookmarked,
    };
  }
  return {
    cardsVersion,
    settings,
    decks: deckRows,
    states,
    cards: cardRows?.map((c): SnapshotCard => ({ ...c, media: c.media ?? [], meta: clientMeta(c.meta) })),
  };
}

export type OfflineAnswer = { card_id: string; answer: "again" | "good"; at: number };

const MAX_ANSWERS = 5000;

export function parseOfflineAnswers(body: unknown): OfflineAnswer[] {
  const list = (body as { answers?: unknown } | null)?.answers;
  if (!Array.isArray(list)) throw badRequest("Expected {answers: [...]}");
  if (list.length > MAX_ANSWERS) throw badRequest(`At most ${MAX_ANSWERS} answers per sync`);
  return list.map((a, i) => {
    const x = (a ?? {}) as Record<string, unknown>;
    if (typeof x.card_id !== "string" || !x.card_id) throw badRequest(`answers[${i}].card_id is required`);
    if (x.answer !== "again" && x.answer !== "good") throw badRequest(`answers[${i}].answer must be again or good`);
    if (typeof x.at !== "number" || !Number.isFinite(x.at)) throw badRequest(`answers[${i}].at must be a time`);
    return { card_id: x.card_id, answer: x.answer, at: Math.round(x.at) };
  });
}

/**
 * Applies answers given offline, in the order they were given, exactly as if they had been sent
 * one by one. An answer the server already has (same card and time: it reached the server but the
 * reply didn't reach the phone) is skipped, as is one for a card that no longer exists.
 */
export async function applyOfflineAnswers(db: DB, answers: OfflineAnswer[]) {
  let applied = 0;
  let skipped = 0;
  for (const a of answers) {
    const at = new Date(a.at);
    const [seen] = await db
      .select({ id: reviewLog.id })
      .from(reviewLog)
      .where(and(eq(reviewLog.cardId, a.card_id), eq(reviewLog.reviewedAt, at)))
      .limit(1);
    const [exists] = await db.select({ id: cards.id }).from(cards).where(eq(cards.id, a.card_id)).limit(1);
    if (seen || !exists) {
      skipped++;
      continue;
    }
    await applyReview(db, { card_id: a.card_id, answer: a.answer }, at);
    applied++;
  }
  return { applied, skipped };
}

/** When an answer was given, as sent by the phone; the server's clock if it's missing or implausible. */
export function answerTime(at: unknown, now = Date.now()): Date {
  const ok = typeof at === "number" && Number.isFinite(at) && at > now - 90 * 86_400_000 && at < now + 5 * 60_000;
  return new Date(ok ? Math.round(at) : now);
}
