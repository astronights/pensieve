/**
 * The study queue, run on the phone over the offline copy (snapshot) when the server can't be
 * reached. It mirrors the server exactly (queue.ts picks the next card, review.ts applies an answer)
 * so that answers given offline and replayed on the server later end up the same; tests/engine
 * checks the two side by side.
 */
import type { CardDTO, Counts, DeckSummary, NextFilters, NextResult } from "./queue";
import { afterAgain, afterGood, goodsNeeded, MIX_EVERY } from "./schedule";
import type { Snapshot, SnapshotCard, SnapshotDeck, SnapshotState } from "./snapshot";
import { searchableText, searchTerms } from "./text-search";

export class OfflineError extends Error {}

/** Cards of a deck and its sub-decks. */
function scope(snap: Snapshot, deckId: string): SnapshotCard[] {
  const ids = new Set(snap.decks.filter((d) => d.id === deckId || d.parent === deckId).map((d) => d.id));
  return (snap.cards ?? []).filter((c) => ids.has(c.deck));
}

const unseen = (s: SnapshotState | undefined) => !s || (!s.seen && s.dueAt === null && !s.learned);

export function countsFor(snap: Snapshot, deckId: string): Counts {
  const counts: Counts = { learning: 0, new: 0, learned: 0, total: 0 };
  for (const c of scope(snap, deckId)) {
    const s = snap.states[c.id];
    counts.total++;
    if (s?.dueAt != null) counts.learning++;
    if (s?.learned) counts.learned++;
    if (unseen(s)) counts.new++;
  }
  return counts;
}

export function listDecksOffline(snap: Snapshot): DeckSummary[] {
  return [...snap.decks]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((d) => ({ id: d.id, name: d.name, kind: d.kind, parent: d.parent, ...countsFor(snap, d.id) }));
}

const deckById = (snap: Snapshot, id: string) => snap.decks.find((d) => d.id === id);

function toDTO(snap: Snapshot, c: SnapshotCard): CardDTO {
  const s = snap.states[c.id];
  return {
    id: c.id,
    deck: c.deck,
    front: c.front,
    back: c.back,
    tags: c.tags,
    category: c.category,
    media: c.media,
    meta: c.meta,
    streak: s?.streak ?? 0,
    learning: s?.dueAt != null,
    missed: s?.missed ?? false,
    bookmarked: s?.bookmarked ?? false,
  };
}

/** The next card, as GET /api/next would pick it (see queue.ts nextCard for the rules). */
export function nextCardOffline(
  snap: Snapshot,
  deckId: string,
  filters: NextFilters = {},
  random: () => number = Math.random,
): NextResult {
  const d = deckById(snap, deckId);
  if (!d || !snap.cards) throw new OfflineError(`Deck not found offline: ${deckId}`);
  const parent = d.parent ? deckById(snap, d.parent) : undefined;
  const deck = { id: d.id, name: d.name, kind: d.kind, group: parent?.name ?? d.name };
  const counts = countsFor(snap, deckId);
  const position = (parent ?? d).answers;

  const pool = scope(snap, deckId).filter(
    (c) =>
      (!filters.category || c.category === filters.category) &&
      (!filters.season || (c.meta as { season?: unknown } | null)?.season === filters.season) &&
      (!filters.exclude || c.id !== filters.exclude),
  );
  const learning = pool
    .filter((c) => snap.states[c.id]?.dueAt != null)
    .sort((a, b) => snap.states[a.id].dueAt! - snap.states[b.id].dueAt! || a.idRank - b.idRank);
  const due = learning.filter((c) => snap.states[c.id].dueAt! <= position);
  const fresh = pool.filter((c) => unseen(snap.states[c.id]));
  const newCard = () =>
    fresh.length === 0
      ? undefined
      : d.kind === "srs"
        ? fresh.reduce((a, b) => (b.order < a.order ? b : a))
        : fresh[Math.floor(random() * fresh.length)];

  let card: SnapshotCard | undefined;
  let source: NextResult["source"] = null;
  if (due.length > 0 && position % MIX_EVERY === MIX_EVERY - 1 && due.length > 1 && (card = newCard())) {
    source = "new";
  } else if (due.length > 0) {
    [card, source] = [due[0], "due"];
  } else if ((card = newCard())) {
    source = "new";
  } else if (learning.length > 0) {
    [card, source] = [learning[0], "ahead"];
  }
  if (!card) return { deck, card: null, source: null, counts };

  const dto = toDTO(snap, card);
  const s = snap.settings;
  return {
    deck,
    card: dto,
    source,
    counts,
    outcomes: {
      again: afterAgain(s, dto.streak, dto.missed).gap,
      good: afterGood(s, dto.streak + 1, dto.missed),
      streak: dto.streak,
      needed: goodsNeeded(s, dto.missed),
      learnedAfter: s.learned_after,
    },
  };
}

/**
 * Applies an answer to the snapshot, as POST /api/review would (see review.ts applyReview): the
 * card's top-level deck counts one more answer and the card moves by Again/Good.
 */
export function answerOffline(snap: Snapshot, cardId: string, answer: "again" | "good"): void {
  const card = snap.cards?.find((c) => c.id === cardId);
  if (!card) throw new OfflineError(`Card not found offline: ${cardId}`);
  const d = deckById(snap, card.deck) as SnapshotDeck;
  const group = (d.parent ? deckById(snap, d.parent) : undefined) ?? d;
  const existing = snap.states[cardId];
  const learning = existing?.dueAt != null;
  const seenOnly = answer === "good" && d.kind === "browse" && !learning;

  group.answers += 1;
  const position = group.answers;
  const base: SnapshotState = existing ?? {
    streak: 0,
    dueAt: null,
    seen: false,
    learned: false,
    missed: false,
    bookmarked: false,
  };
  let next: SnapshotState;
  if (seenOnly) {
    next = { ...base, seen: true };
  } else if (answer === "again") {
    const a = afterAgain(snap.settings, existing?.streak ?? 0, existing?.missed ?? false);
    next = { ...base, seen: true, streak: a.streak, dueAt: position + a.gap, learned: false, missed: true };
  } else {
    const streak = (existing?.streak ?? 0) + 1;
    const g = afterGood(snap.settings, streak, existing?.missed ?? false);
    next =
      g === "learned"
        ? { ...base, seen: true, streak, dueAt: null, learned: true }
        : { ...base, seen: true, streak, dueAt: position + g };
  }
  snap.states[cardId] = next;
}

/** Search over the offline copy (see search.ts for the server's). */
export function searchOffline(snap: Snapshot, query: string, limit = 50) {
  const terms = searchTerms(query);
  if (terms.length === 0 || !snap.cards) return { total: 0, cards: [] };
  const groupName = (c: SnapshotCard) => {
    const d = deckById(snap, c.deck)!;
    return (d.parent && deckById(snap, d.parent)?.name) || d.name;
  };
  const deckName = (c: SnapshotCard) => {
    const d = deckById(snap, c.deck)!;
    const p = d.parent ? deckById(snap, d.parent) : undefined;
    return p ? `${p.name} › ${d.name}` : d.name;
  };
  const hits = snap.cards
    .filter((c) => {
      const text = searchableText(c);
      return terms.every((t) => text.includes(t));
    })
    .sort((a, b) => {
      const ga = groupName(a);
      const gb = groupName(b);
      return ga < gb ? -1 : ga > gb ? 1 : a.idRank - b.idRank;
    });
  return {
    total: hits.length,
    cards: hits.slice(0, limit).map((c) => {
      const s = snap.states[c.id];
      return {
        id: c.id,
        deck: c.deck,
        deckName: deckName(c),
        front: c.front,
        back: c.back,
        category: c.category,
        meta: c.meta,
        status: (s?.learned ? "learned" : s?.dueAt != null ? "learning" : "new") as "learned" | "learning" | "new",
      };
    }),
  };
}
