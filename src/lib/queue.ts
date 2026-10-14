import { and, asc, eq, isNotNull, lte, ne, type SQL, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { cards, cardState, decks, type DeckKind, type MediaItem } from "@/db/schema";
import { clientMeta } from "./card-extras";
import { notFound } from "./errors";
import { getSettings, goodGap } from "./settings";

export type DeckSummary = {
  id: string;
  name: string;
  kind: DeckKind;
  /** Parent deck id for a sub-deck; null for a top-level deck. */
  parent: string | null;
  /** Cards being learned: answered but not yet learned (a parent includes its sub-decks). */
  learning: number;
  /** Cards never seen. */
  new: number;
  /** Cards answered Good enough times in a row; they aren't shown again. */
  learned: number;
  total: number;
};

export type Counts = Pick<DeckSummary, "learning" | "new" | "learned" | "total">;

export type CardDTO = {
  id: string;
  deck: string;
  front: string;
  back: string;
  tags: string[];
  category: string | null;
  media: MediaItem[];
  meta: Record<string, unknown> | null;
  /** Goods in a row so far. */
  streak: number;
  /** In the Again/Good loop (a browse-deck card only joins it on Again). */
  learning: boolean;
  bookmarked: boolean;
};

export type NextResult = {
  deck: { id: string; name: string; kind: DeckKind };
  card: CardDTO | null;
  /** due: its turn came up; new: never seen; ahead: nothing else left, so shown early. */
  source: "due" | "new" | "ahead" | null;
  counts: Counts;
  /** What each answer does: how many cards later it returns, or "learned" for the final Good. */
  outcomes?: { again: number; good: number | "learned"; streak: number; learnedAfter: number };
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

/** The answer counter: every answer appends a review_log row, so its latest id counts answers. */
const position = sql.raw(`(select coalesce(max("id"), 0) from "review_log")`);

/** Never seen. A card_state row can exist without that (e.g. the card was only bookmarked). */
const unseen = sql.raw(
  `("card_state"."card_id" is null or ("card_state"."seen_at" is null and "card_state"."due_at" is null and "card_state"."learned_at" is null))`,
);

/** Cards of the outer `decks` row, including its sub-decks' cards. */
const inDeckScope = sql.raw(
  `"cards"."deck" in (select "s"."id" from "decks" "s" where "s"."id" = "decks"."id" or "s"."parent" = "decks"."id")`,
);

/** Cards in deck `deckId` or one of its sub-decks. */
const deckScope = (deckId: string) =>
  sql`${cards.deck} in (select "s"."id" from "decks" "s" where "s"."id" = ${deckId} or "s"."parent" = ${deckId})`;

const countWhere = (cond: string) =>
  sql<number>`(
    select count(*) from "cards"
    left join "card_state" on "card_state"."card_id" = "cards"."id"
    where ${inDeckScope} and ${sql.raw(cond)}
  )`.mapWith(Number);

export async function listDecks(db: DB, deckId?: string): Promise<DeckSummary[]> {
  return db
    .select({
      id: decks.id,
      name: decks.name,
      kind: decks.kind,
      parent: decks.parent,
      learning: countWhere(`"card_state"."due_at" is not null`),
      new: sql<number>`(
        select count(*) from "cards"
        left join "card_state" on "card_state"."card_id" = "cards"."id"
        where ${inDeckScope} and ${unseen}
      )`.mapWith(Number),
      learned: countWhere(`"card_state"."learned_at" is not null`),
      total: countWhere("true"),
    })
    .from(decks)
    .where(deckId ? eq(decks.id, deckId) : undefined)
    .orderBy(asc(decks.name));
}

export const toCounts = ({ learning, new: fresh, learned, total }: DeckSummary): Counts => ({
  learning,
  new: fresh,
  learned,
  total,
});

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
  streak: cardState.streak,
  dueAt: cardState.dueAt,
  bookmarked: cardState.bookmarked,
};

type CardRow = Omit<CardDTO, "streak" | "learning" | "bookmarked"> & {
  streak: number | null;
  dueAt: number | null;
  bookmarked: boolean | null;
};

const toDTO = ({ dueAt, ...r }: CardRow): CardDTO => ({
  ...r,
  meta: clientMeta(r.meta),
  media: r.media ?? [],
  streak: r.streak ?? 0,
  learning: dueAt !== null,
  bookmarked: r.bookmarked ?? false,
});

/**
 * Picks the next card to show. There is no daily limit; cards are placed by how many answers
 * ago they were answered, not by time.
 * 1. A card being learned whose turn has come (Again/Good moved it N cards back), earliest first.
 * 2. Otherwise a new card: import order (SRS decks) or random (browse decks).
 * 3. Otherwise the card being learned that is next in line, shown early.
 * Learned cards are never shown.
 */
export async function nextCard(db: DB, deckId: string, filters: NextFilters = {}): Promise<NextResult> {
  const [summary] = await listDecks(db, deckId);
  if (!summary) throw notFound(`Deck not found: ${deckId}`);
  const deck = { id: summary.id, name: summary.name, kind: summary.kind };
  const counts = toCounts(summary);
  const extra = filterConditions(filters);

  const learningCard = async (dueOnly: boolean) => {
    const [row] = await db
      .select(cardColumns)
      .from(cards)
      .innerJoin(cardState, eq(cardState.cardId, cards.id))
      .where(
        and(
          deckScope(deckId),
          isNotNull(cardState.dueAt),
          dueOnly ? lte(cardState.dueAt, position) : undefined,
          ...extra,
        ),
      )
      .orderBy(asc(cardState.dueAt), asc(cards.id))
      .limit(1);
    return row;
  };

  const pick = async (): Promise<Pick<NextResult, "card" | "source">> => {
    const due = await learningCard(true);
    if (due) return { card: toDTO(due), source: "due" };

    const [fresh] = await db
      .select(cardColumns)
      .from(cards)
      .leftJoin(cardState, eq(cardState.cardId, cards.id))
      .where(and(deckScope(deckId), unseen, ...extra))
      .orderBy(...(deck.kind === "srs" ? [asc(cards.createdAt), asc(cards.id)] : [sql`random()`]))
      .limit(1);
    if (fresh) return { card: toDTO(fresh), source: "new" };

    const ahead = await learningCard(false);
    if (ahead) return { card: toDTO(ahead), source: "ahead" };
    return { card: null, source: null };
  };

  const { card, source } = await pick();
  if (!card) return { deck, card, source, counts };

  const settings = await getSettings(db);
  const streak = card.streak + 1;
  return {
    deck,
    card,
    source,
    counts,
    outcomes: {
      again: settings.again_gap,
      good: streak >= settings.learned_after ? "learned" : goodGap(settings, streak),
      streak: card.streak,
      learnedAfter: settings.learned_after,
    },
  };
}
