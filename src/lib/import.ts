import { sql } from "drizzle-orm";
import type { DB } from "@/db";
import { cards, decks, type DeckKind, type MediaItem } from "@/db/schema";
import { badRequest } from "./errors";

export type ImportCard = {
  id: string;
  deck: string;
  front: string;
  back: string;
  tags: string[];
  category: string | null;
  media: MediaItem[];
  meta: Record<string, unknown> | null;
};

export type ImportDeck = {
  id: string;
  name: string;
  /** Omitted: a sub-deck takes its parent's kind; a top-level deck keeps its current kind (new: srs). */
  kind?: DeckKind;
  /** Top-level deck this deck belongs to. Omitted or null: a top-level deck. */
  parent: string | null;
};

export type ImportPayload = { decks: ImportDeck[]; cards: ImportCard[] };

export const MAX_IMPORT_CARDS = 5000;
const CHUNK = 500;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const nonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

function parseMedia(v: unknown, where: string): MediaItem[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw badRequest(`${where}.media must be an array`);
  return v.map((m, i) => {
    const at = `${where}.media[${i}]`;
    if (!isObject(m)) throw badRequest(`${at} must be an object`);
    if (m.type !== "image" && m.type !== "video" && m.type !== "audio") {
      throw badRequest(`${at}.type must be image, video or audio`);
    }
    if (m.side !== "front" && m.side !== "back") throw badRequest(`${at}.side must be front or back`);
    if (typeof m.url !== "string") throw badRequest(`${at}.url must be a string`);
    let url: URL;
    try {
      url = new URL(m.url);
    } catch {
      throw badRequest(`${at}.url is not a valid URL`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw badRequest(`${at}.url must be an http(s) URL`);
    }
    return { type: m.type, url: m.url, side: m.side };
  });
}

function parseCard(v: unknown, i: number): ImportCard {
  const at = `cards[${i}]`;
  if (!isObject(v)) throw badRequest(`${at} must be an object`);
  for (const k of ["id", "deck"] as const) {
    if (!nonEmptyString(v[k])) throw badRequest(`${at}.${k} must be a non-empty string`);
  }
  for (const k of ["front", "back"] as const) {
    if (typeof v[k] !== "string") throw badRequest(`${at}.${k} must be a string`);
  }
  if (v.tags !== undefined && !(Array.isArray(v.tags) && v.tags.every((t) => typeof t === "string"))) {
    throw badRequest(`${at}.tags must be an array of strings`);
  }
  if (v.category !== undefined && v.category !== null && typeof v.category !== "string") {
    throw badRequest(`${at}.category must be a string`);
  }
  if (v.meta !== undefined && v.meta !== null && !isObject(v.meta)) {
    throw badRequest(`${at}.meta must be an object`);
  }
  return {
    id: v.id as string,
    deck: v.deck as string,
    front: v.front as string,
    back: v.back as string,
    tags: (v.tags as string[] | undefined) ?? [],
    category: (v.category as string | null | undefined) ?? null,
    media: parseMedia(v.media, at),
    meta: (v.meta as Record<string, unknown> | null | undefined) ?? null,
  };
}

function parseDeck(v: unknown, i: number): ImportDeck {
  const at = `decks[${i}]`;
  if (!isObject(v)) throw badRequest(`${at} must be an object`);
  if (!nonEmptyString(v.id)) throw badRequest(`${at}.id must be a non-empty string`);
  if (v.kind !== undefined && v.kind !== "srs" && v.kind !== "browse") {
    throw badRequest(`${at}.kind must be srs or browse`);
  }
  if (v.parent !== undefined && v.parent !== null && !nonEmptyString(v.parent)) {
    throw badRequest(`${at}.parent must be a deck id`);
  }
  if (v.parent === v.id) throw badRequest(`${at}: a deck can't be its own parent`);
  return {
    id: v.id,
    name: nonEmptyString(v.name) ? v.name : v.id,
    ...(v.kind !== undefined && { kind: v.kind as DeckKind }),
    parent: (v.parent as string | null | undefined) ?? null,
  };
}

type DeckRow = { id: string; name: string; kind: DeckKind; parent: string | null };

/**
 * Merges incoming decks into the existing ones and checks the sub-deck rules:
 * one level only (a parent must be top-level, and a deck with sub-decks can't become one),
 * and a sub-deck always has its parent's kind. Returns every deck row to write.
 */
export function resolveDecks(existing: DeckRow[], incoming: ImportDeck[], implicitIds: string[]): DeckRow[] {
  const final = new Map(existing.map((d) => [d.id, { ...d }]));
  for (const d of incoming) {
    const prev = final.get(d.id);
    final.set(d.id, { id: d.id, name: d.name, kind: d.kind ?? prev?.kind ?? "srs", parent: d.parent });
  }
  for (const id of implicitIds) {
    if (!final.has(id)) final.set(id, { id, name: id, kind: "srs", parent: null });
  }

  const hasChildren = new Set([...final.values()].map((d) => d.parent).filter(Boolean));
  for (const d of incoming) {
    if (!d.parent) continue;
    const parent = final.get(d.parent);
    if (!parent) throw badRequest(`Deck ${d.id}: parent deck ${d.parent} doesn't exist`);
    if (parent.parent) {
      throw badRequest(`Deck ${d.id}: ${d.parent} is itself a sub-deck (only one level of sub-decks is allowed)`);
    }
    if (hasChildren.has(d.id)) {
      throw badRequest(
        `Deck ${d.id} has sub-decks, so it can't become a sub-deck itself (only one level of sub-decks is allowed)`,
      );
    }
    if (d.kind && d.kind !== parent.kind) {
      throw badRequest(`Deck ${d.id}: a sub-deck must have its parent's kind (${parent.kind})`);
    }
  }
  // Sub-decks follow their parent's kind, including existing ones when a parent's kind changes.
  for (const d of final.values()) {
    if (d.parent) d.kind = final.get(d.parent)!.kind;
  }

  const touched = new Set([
    ...incoming.map((d) => d.id),
    ...implicitIds,
    ...[...final.values()].filter((d) => d.parent && final.get(d.parent)).map((d) => d.id),
  ]);
  const before = new Map(existing.map((d) => [d.id, d]));
  return [...final.values()].filter((d) => {
    if (!touched.has(d.id)) return false;
    const b = before.get(d.id);
    return !b || b.name !== d.name || b.kind !== d.kind || b.parent !== d.parent;
  });
}

/** Accepts either a bare array of cards or `{ decks?: [...], cards: [...] }`. */
export function parseImportPayload(body: unknown): ImportPayload {
  const rawCards = Array.isArray(body) ? body : isObject(body) ? body.cards : undefined;
  const rawDecks = isObject(body) ? (body.decks ?? []) : [];
  if (!Array.isArray(rawCards)) throw badRequest("Expected an array of cards or { cards: [...] }");
  if (!Array.isArray(rawDecks)) throw badRequest("decks must be an array");
  if (rawCards.length > MAX_IMPORT_CARDS) {
    throw badRequest(`Too many cards in one request (max ${MAX_IMPORT_CARDS})`);
  }
  const parsedCards = rawCards.map(parseCard);
  const parsedDecks = rawDecks.map(parseDeck);
  const deckIds = new Set<string>();
  for (const d of parsedDecks) {
    if (deckIds.has(d.id)) throw badRequest(`Duplicate deck id in payload: ${d.id}`);
    deckIds.add(d.id);
  }
  const seen = new Set<string>();
  for (const c of parsedCards) {
    if (seen.has(c.id)) throw badRequest(`Duplicate card id in payload: ${c.id}`);
    seen.add(c.id);
  }
  return { decks: parsedDecks, cards: parsedCards };
}

export type ImportResult = { decks: number; cards: number };

/**
 * Upserts decks and cards by id. Card content is replaced, but card_state and
 * review_log are never touched, so re-importing keeps all study progress.
 * Decks referenced by cards but not listed are created as top-level `srs` decks if missing.
 */
export async function importCards(db: DB, payload: ImportPayload): Promise<ImportResult> {
  const listed = new Set(payload.decks.map((d) => d.id));
  const implicitIds = [...new Set(payload.cards.map((c) => c.deck))].filter((id) => !listed.has(id));

  await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: decks.id, name: decks.name, kind: decks.kind, parent: decks.parent })
      .from(decks);
    const rows = resolveDecks(existing, payload.decks, implicitIds);
    // Parents first, so a sub-deck's foreign key always finds its parent.
    for (const level of [rows.filter((d) => !d.parent), rows.filter((d) => d.parent)]) {
      if (level.length === 0) continue;
      await tx
        .insert(decks)
        .values(level)
        .onConflictDoUpdate({
          target: decks.id,
          set: { name: sql`excluded.name`, kind: sql`excluded.kind`, parent: sql`excluded.parent` },
        });
    }
    for (let i = 0; i < payload.cards.length; i += CHUNK) {
      await tx
        .insert(cards)
        .values(payload.cards.slice(i, i + CHUNK))
        .onConflictDoUpdate({
          target: cards.id,
          set: {
            deck: sql`excluded.deck`,
            front: sql`excluded.front`,
            back: sql`excluded.back`,
            tags: sql`excluded.tags`,
            category: sql`excluded.category`,
            media: sql`excluded.media`,
            meta: sql`excluded.meta`,
            updatedAt: sql`now()`,
          },
        });
    }
  });
  return { decks: payload.decks.length + implicitIds.length, cards: payload.cards.length };
}
