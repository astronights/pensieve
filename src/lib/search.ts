import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { DB } from "@/db";
import { cards, cardState, decks } from "@/db/schema";
import { clientMeta } from "./card-extras";
import { badRequest } from "./errors";

export const SEARCH_LIMIT = 50;

/**
 * Keywords from a search box: words, or "quoted phrases" kept together. Lower-cased, without the
 * stress marks Russian cards carry and without Markdown escapes, the same as the text searched.
 */
export function searchTerms(query: string): string[] {
  const terms: string[] = [];
  for (const m of query.matchAll(/"([^"]+)"|(\S+)/g)) {
    const t = normalise(m[1] ?? m[2]);
    if (t && !terms.includes(t)) terms.push(t);
  }
  return terms.slice(0, 10);
}

/** Combining grave and acute accents: the stress marks on Russian words. */
const STRESS_MARKS = String.fromCharCode(0x300, 0x301);
const STRESS = new RegExp(`[${STRESS_MARKS}]`, "g");

const normalise = (s: string) =>
  s.normalize("NFD").replace(STRESS, "").normalize("NFC").replace(/\\/g, "").toLowerCase().trim();

/**
 * Everything on a card worth searching, as Postgres sees it: question, answer, category, tags and
 * the notes/explanation/info extras (not the raw source record), stress marks and escapes removed.
 */
const searchable = sql`lower(replace(translate(concat_ws(' ',
  ${cards.front}, ${cards.back}, ${cards.category}, array_to_string(${cards.tags}, ' '),
  ${cards.meta}->>'notes', ${cards.meta}->>'explanation',
  (select string_agg(concat_ws(' ', i->>'label', i->>'value'), ' ')
     from jsonb_array_elements(case when jsonb_typeof(${cards.meta}->'info') = 'array'
       then ${cards.meta}->'info' else '[]'::jsonb end) i)
), ${STRESS_MARKS}, ''), '\\', ''))`;

const like = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export type SearchHit = {
  id: string;
  deck: string;
  /** "Parent › Sub-deck", or the deck's name. */
  deckName: string;
  front: string;
  back: string;
  category: string | null;
  meta: Record<string, unknown> | null;
  status: "learned" | "learning" | "new";
};

/** Cards containing every term (anywhere, any case), in deck order; at most SEARCH_LIMIT of them. */
export async function searchCards(db: DB, query: string): Promise<{ total: number; cards: SearchHit[] }> {
  if (query.length > 200) throw badRequest("Search is too long");
  const terms = searchTerms(query);
  if (terms.length === 0) return { total: 0, cards: [] };
  const where: SQL = and(...terms.map((t) => sql`${searchable} like ${like(t)}`))!;
  const parent = alias(decks, "parent");

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: cards.id,
        deck: cards.deck,
        deckName: sql<string>`case when ${parent.name} is null then ${decks.name} else ${parent.name} || ' › ' || ${decks.name} end`,
        front: cards.front,
        back: cards.back,
        category: cards.category,
        meta: cards.meta,
        learnedAt: cardState.learnedAt,
        dueAt: cardState.dueAt,
      })
      .from(cards)
      .innerJoin(decks, eq(decks.id, cards.deck))
      .leftJoin(parent, eq(parent.id, decks.parent))
      .leftJoin(cardState, eq(cardState.cardId, cards.id))
      .where(where)
      .orderBy(sql`coalesce(${parent.name}, ${decks.name})`, asc(cards.id))
      .limit(SEARCH_LIMIT),
    db
      .select({ total: sql<number>`count(*)`.mapWith(Number) })
      .from(cards)
      .where(where),
  ]);

  return {
    total,
    cards: rows.map(({ learnedAt, dueAt, meta, ...r }) => ({
      ...r,
      meta: clientMeta(meta),
      status: learnedAt ? "learned" : dueAt !== null ? "learning" : "new",
    })),
  };
}
