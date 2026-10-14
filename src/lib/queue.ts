import { and, asc, eq, lte, ne, or, type SQL, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { cards, cardState, decks, type DeckKind, type MediaItem } from "@/db/schema";
import { clientMeta } from "./card-extras";
import { notFound } from "./errors";
import { getSettings } from "./settings";

/** If nothing else is left, learning cards due within this window are shown early (like Anki). */
export const LEARN_AHEAD_MS = 20 * 60 * 1000;

export type DeckSummary = {
  id: string;
  name: string;
  kind: DeckKind;
  /** Parent deck id for a sub-deck; null for a top-level deck. */
  parent: string | null;
  /** Cards in FSRS whose due time has passed (a parent includes its sub-decks). */
  due: number;
  /** SRS: new cards still available today (capped). Browse: unseen cards. */
  new: number;
  /** Cards never seen or reviewed, ignoring the daily cap. */
  unseen: number;
};

export type CardDTO = {
  id: string;
  deck: string;
  front: string;
  back: string;
  tags: string[];
  category: string | null;
  media: MediaItem[];
  meta: Record<string, unknown> | null;
  state: (typeof cardState.$inferSelect)["state"] | null;
  inReviewQueue: boolean;
  bookmarked: boolean;
};

export type NextResult = {
  deck: { id: string; name: string; kind: DeckKind };
  card: CardDTO | null;
  source: "due" | "learn_ahead" | "new" | "unseen" | null;
  counts: { due: number; new: number; unseen: number };
};

export type NextFilters = {
  category?: string | null;
  season?: string | null;
  /**
   * Skip this card. The client prefetches "the card after the current one" before the current
   * card's answer is saved, so the current card must not be picked again.
   */
  exclude?: string | null;
};

const ts = (d: Date) => sql`${d.toISOString()}::timestamptz`;

/** Local midnight in `tz` for the day containing `now`, as a timestamptz expression. */
const dayStart = (now: Date, tz: string) =>
  sql`(date_trunc('day', ${ts(now)} at time zone ${tz}) at time zone ${tz})`;

/**
 * FSRS-managed: SRS-deck cards reviewed at least once, plus any card explicitly put in the review queue.
 * Written with qualified names so it is safe inside correlated subqueries; needs `decks` and `card_state` in scope.
 */
const inFsrs = sql.raw(
  `(("decks"."kind" = 'srs' and "card_state"."reps" > 0) or "card_state"."in_review_queue")`,
);

/**
 * Never reviewed or seen. A card_state row can exist without the card being seen
 * (e.g. it was only bookmarked), so this checks more than row existence.
 */
const unseen = sql.raw(
  `("card_state"."card_id" is null or ("card_state"."reps" = 0 and "card_state"."last_review" is null and not "card_state"."in_review_queue"))`,
);

/** Cards of the outer `decks` row, including its sub-decks' cards (a sub-deck has none of its own). */
const inDeckScope = sql.raw(
  `"cards"."deck" in (select "s"."id" from "decks" "s" where "s"."id" = "decks"."id" or "s"."parent" = "decks"."id")`,
);

/** Cards of the outer deck's whole top-level group: the daily new-card limit is shared across it. */
const inDeckGroup = sql.raw(
  `"cards"."deck" in (select "g"."id" from "decks" "g" where coalesce("g"."parent", "g"."id") = coalesce("decks"."parent", "decks"."id"))`,
);

/** Cards in deck `deckId` or one of its sub-decks. */
const deckScope = (deckId: string) =>
  sql`${cards.deck} in (select "s"."id" from "decks" "s" where "s"."id" = ${deckId} or "s"."parent" = ${deckId})`;

export async function listDecks(db: DB, now = new Date(), deckId?: string): Promise<DeckSummary[]> {
  const { daily_new_limit, timezone } = await getSettings(db);
  const rows = await db
    .select({
      id: decks.id,
      name: decks.name,
      kind: decks.kind,
      parent: decks.parent,
      due: sql<number>`(
        select count(*) from "cards"
        join "card_state" on "card_state"."card_id" = "cards"."id"
        where ${inDeckScope} and "card_state"."due" <= ${ts(now)} and ${inFsrs}
      )`.mapWith(Number),
      unseen: sql<number>`(
        select count(*) from "cards"
        left join "card_state" on "card_state"."card_id" = "cards"."id"
        where ${inDeckScope} and ${unseen}
      )`.mapWith(Number),
      newToday: sql<number>`(
        select count(*) from "review_log"
        join "cards" on "cards"."id" = "review_log"."card_id"
        where ${inDeckGroup}
          and "review_log"."state_before" = 'new'
          and "review_log"."reviewed_at" >= ${dayStart(now, timezone)}
      )`.mapWith(Number),
    })
    .from(decks)
    .where(deckId ? eq(decks.id, deckId) : undefined)
    .orderBy(asc(decks.name));

  return rows.map(({ newToday, ...d }) => ({
    ...d,
    new: d.kind === "srs" ? Math.min(d.unseen, Math.max(0, daily_new_limit - newToday)) : d.unseen,
  }));
}

function filterConditions(f: NextFilters): SQL[] {
  const out: SQL[] = [];
  if (f.category) out.push(eq(cards.category, f.category));
  if (f.season) out.push(sql`${cards.meta}->>'season' = ${f.season}`);
  if (f.exclude) out.push(ne(cards.id, f.exclude));
  return out;
}

const cardColumns = {
  id: cards.id,
  deck: cards.deck,
  front: cards.front,
  back: cards.back,
  tags: cards.tags,
  category: cards.category,
  media: cards.media,
  meta: cards.meta,
  state: cardState.state,
  inReviewQueue: cardState.inReviewQueue,
  bookmarked: cardState.bookmarked,
};

type CardRow = {
  [K in keyof typeof cardColumns]: K extends "state" | "inReviewQueue" | "bookmarked"
    ? CardDTO[K] | null
    : CardDTO[K];
};

const toDTO = (r: CardRow): CardDTO => ({
  ...r,
  meta: clientMeta(r.meta),
  media: r.media ?? [],
  inReviewQueue: r.inReviewQueue ?? false,
  bookmarked: r.bookmarked ?? false,
});

/**
 * Picks the next card to show.
 * - Both deck kinds: FSRS cards that are due come first (oldest due first).
 * - SRS decks: then new cards in import order, up to the daily cap; then learning cards due soon.
 * - Browse decks: then a random unseen card.
 */
export async function nextCard(
  db: DB,
  deckId: string,
  filters: NextFilters = {},
  now = new Date(),
): Promise<NextResult> {
  const [summary] = await listDecks(db, now, deckId);
  if (!summary) throw notFound(`Deck not found: ${deckId}`);
  const deck = { id: summary.id, name: summary.name, kind: summary.kind };
  const counts = { due: summary.due, new: summary.new, unseen: summary.unseen };
  const extra = filterConditions(filters);

  const fsrsCard = async (until: Date, learningOnly: boolean) => {
    const [row] = await db
      .select(cardColumns)
      .from(cards)
      .innerJoin(cardState, eq(cardState.cardId, cards.id))
      .innerJoin(decks, eq(decks.id, cards.deck))
      .where(
        and(
          deckScope(deckId),
          lte(cardState.due, until),
          inFsrs,
          learningOnly
            ? or(eq(cardState.state, "learning"), eq(cardState.state, "relearning"))
            : undefined,
          ...extra,
        ),
      )
      .orderBy(asc(cardState.due), asc(cards.id))
      .limit(1);
    return row;
  };

  const due = await fsrsCard(now, false);
  if (due) return { deck, card: toDTO(due), source: "due", counts };

  let newAvailable = deck.kind === "srs" ? counts.new : counts.unseen;
  if (filters.exclude && deck.kind === "srs" && newAvailable === 1) {
    // The excluded card may be the last new card allowed today (its answer isn't saved yet).
    const [excludedIsNew] = await db
      .select({ id: cards.id })
      .from(cards)
      .leftJoin(cardState, eq(cardState.cardId, cards.id))
      .where(and(eq(cards.id, filters.exclude), deckScope(deckId), unseen))
      .limit(1);
    if (excludedIsNew) newAvailable = 0;
  }

  if (newAvailable > 0) {
    const [fresh] = await db
      .select(cardColumns)
      .from(cards)
      .leftJoin(cardState, eq(cardState.cardId, cards.id))
      .where(and(deckScope(deckId), unseen, ...extra))
      .orderBy(...(deck.kind === "srs" ? [asc(cards.createdAt), asc(cards.id)] : [sql`random()`]))
      .limit(1);
    if (fresh) {
      return { deck, card: toDTO(fresh), source: deck.kind === "srs" ? "new" : "unseen", counts };
    }
  }

  const ahead = await fsrsCard(new Date(now.getTime() + LEARN_AHEAD_MS), true);
  if (ahead) return { deck, card: toDTO(ahead), source: "learn_ahead", counts };

  return { deck, card: null, source: null, counts };
}
