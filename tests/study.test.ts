import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import { cardState, reviewLog, settings as settingsTable } from "@/db/schema";
import { HttpError } from "@/lib/errors";
import { importCards, parseImportPayload } from "@/lib/import";
import { listDecks, nextCard } from "@/lib/queue";
import { applyReview, parseReviewInput } from "@/lib/review";
import { SEED } from "@/lib/seed-data";
import { getSettings, updateSettings } from "@/lib/settings";
import { createTestDb } from "./helpers/db";


let db: DB;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => close());

const srsDeck = (n: number) =>
  parseImportPayload({
    decks: [{ id: "lang", name: "Lang", kind: "srs" }],
    cards: Array.from({ length: n }, (_, i) => ({
      id: `lang:${String(i).padStart(3, "0")}`,
      deck: "lang",
      front: `f${i}`,
      back: `b${i}`,
    })),
  });

const browseDeck = () =>
  parseImportPayload({
    decks: [{ id: "quiz", name: "Quiz", kind: "browse" }],
    cards: [
      { id: "q1", deck: "quiz", front: "1", back: "1", category: "science", meta: { season: "S1" } },
      { id: "q2", deck: "quiz", front: "2", back: "2", category: "art", meta: { season: "S1" } },
      { id: "q3", deck: "quiz", front: "3", back: "3", category: "science", meta: { season: "S2" } },
    ],
  });

const deck = async (id: string) => (await listDecks(db)).find((d) => d.id === id)!;
const next = (deckId: string, filters = {}) => nextCard(db, deckId, filters);
const again = (id: string) => applyReview(db, { card_id: id, answer: "again" });
const good = (id: string) => applyReview(db, { card_id: id, answer: "good" });
const id = (i: number) => `lang:${String(i).padStart(3, "0")}`;

/** Answers whatever comes up next with `choose`, `n` times; returns the ids shown. */
async function study(deckId: string, n: number, choose: (cardId: string) => "again" | "good" = () => "good") {
  const shown: string[] = [];
  for (let i = 0; i < n; i++) {
    const { card } = await next(deckId);
    if (!card) break;
    shown.push(card.id);
    await applyReview(db, { card_id: card.id, answer: choose(card.id) });
  }
  return shown;
}

describe("settings", () => {
  it("uses defaults and validates updates", async () => {
    expect(await getSettings(db)).toEqual({ again_gap: 5, good_gap: 15, learned_after: 3 });
    expect(await updateSettings(db, { good_gap: 20 })).toMatchObject({ good_gap: 20 });
    await expect(updateSettings(db, { again_gap: 0 })).rejects.toThrow(HttpError);
    await expect(updateSettings(db, { learned_after: 2.5 })).rejects.toThrow(HttpError);
    await expect(updateSettings(db, { daily_new_limit: 15 })).rejects.toThrow(HttpError);
  });

  it("caches reads and refreshes after an update", async () => {
    await getSettings(db);
    // A write that bypasses updateSettings is not seen while cached...
    await db.insert(settingsTable).values({ key: "again_gap", value: 3 });
    expect((await getSettings(db)).again_gap).toBe(5);
    // ...but updateSettings invalidates the cache.
    expect((await updateSettings(db, { good_gap: 10 })).again_gap).toBe(3);
  });
});

describe("parseReviewInput", () => {
  it("validates answers and actions", () => {
    expect(parseReviewInput({ card_id: "a", answer: "good" })).toEqual({ card_id: "a", answer: "good" });
    expect(parseReviewInput({ card_id: "a", action: "bookmark", value: true })).toEqual({
      card_id: "a",
      action: "bookmark",
      value: true,
    });
    expect(() => parseReviewInput({ card_id: "a", answer: "easy" })).toThrow(HttpError);
    expect(() => parseReviewInput({ card_id: "a", rating: 3 })).toThrow(HttpError);
    expect(() => parseReviewInput({ answer: "good" })).toThrow(HttpError);
    expect(() => parseReviewInput({ card_id: "a" })).toThrow(HttpError);
  });
});

describe("SRS decks", () => {
  it("serves new cards in import order with no daily limit", async () => {
    await importCards(db, srsDeck(40));
    expect(await deck("lang")).toMatchObject({ learning: 0, new: 40, learned: 0, total: 40 });
    // With Good every time, the first card is due again only after 15 others.
    const shown = await study("lang", 16);
    expect(shown.slice(0, 15)).toEqual(Array.from({ length: 15 }, (_, i) => id(i)));
    expect(await deck("lang")).toMatchObject({ learning: 16, new: 24 });
  });

  it("Again brings a card back after 5 other cards", async () => {
    await importCards(db, srsDeck(20));
    const shown = await study("lang", 8, (c) => (c === id(0) ? "again" : "good"));
    expect(shown).toEqual([id(0), id(1), id(2), id(3), id(4), id(5), id(0), id(6)]);
  });

  it("Good moves a card back 15, then 30 cards; the third Good in a row learns it", async () => {
    await importCards(db, srsDeck(100));
    const shown = await study("lang", 48);
    const turns = shown.flatMap((c, i) => (c === id(0) ? [i] : []));
    // Shown at answer 0, back after 15 others (index 16), then after 30 more (index 47).
    expect(turns).toEqual([0, 16, 47]);
    const [s] = await db.select().from(cardState).where(eq(cardState.cardId, id(0)));
    expect(s).toMatchObject({ streak: 3, dueAt: null });
    expect(s.learnedAt).not.toBeNull();
    expect(await deck("lang")).toMatchObject({ learned: 1 });
  });

  it("Again resets the streak; learned cards are never shown again", async () => {
    await importCards(db, srsDeck(1));
    expect(await good(id(0))).toMatchObject({ streak: 1, learned: false });
    expect(await good(id(0))).toMatchObject({ streak: 2 });
    expect(await again(id(0))).toMatchObject({ streak: 0, learned: false });
    await good(id(0));
    await good(id(0));
    expect(await good(id(0))).toMatchObject({ streak: 3, learned: true, due_at: null });
    expect((await next("lang")).card).toBeNull();
    expect(await deck("lang")).toMatchObject({ learning: 0, new: 0, learned: 1, total: 1 });
  });

  it("logs every answer", async () => {
    await importCards(db, srsDeck(1));
    await good(id(0));
    await again(id(0));
    const logs = await db.select().from(reviewLog).orderBy(reviewLog.id);
    expect(logs.map((l) => l.answer)).toEqual(["good", "again"]);
  });

  it("describes what each answer will do", async () => {
    await importCards(db, srsDeck(1));
    expect((await next("lang")).outcomes).toEqual({ again: 5, good: 15, streak: 0, learnedAfter: 3 });
    await good(id(0));
    expect((await next("lang")).outcomes).toMatchObject({ good: 30, streak: 1 });
    await good(id(0));
    expect((await next("lang")).outcomes).toMatchObject({ good: "learned", streak: 2 });
  });

  it("uses the configured gaps and streak length", async () => {
    await importCards(db, srsDeck(20));
    await updateSettings(db, { again_gap: 2, good_gap: 3, learned_after: 2 });
    const shown = await study("lang", 6, (c) => (c === id(1) ? "again" : "good"));
    // Again on id(1): two other cards, then it's back (alongside id(0), whose Good gap of 3 is up).
    expect(shown).toEqual([id(0), id(1), id(2), id(3), id(0), id(1)]);
    await study("lang", 20);
    expect((await deck("lang")).learned).toBeGreaterThan(0);
  });

  it("shows the next card being learned early when nothing else is left", async () => {
    await importCards(db, srsDeck(2));
    await good(id(0));
    await again(id(1));
    // Neither card's turn has come and there are no new cards: the one next in line comes up.
    expect(await next("lang")).toMatchObject({ source: "ahead", card: { id: id(1), streak: 0, learning: true } });
  });

  it("exclude skips the current card (used for prefetching)", async () => {
    await importCards(db, srsDeck(10));
    expect((await next("lang", { exclude: id(0) })).card!.id).toBe(id(1));
    await again(id(9));
    await study("lang", 5); // id(0)..id(4); now id(9)'s turn has come
    expect(await next("lang")).toMatchObject({ source: "due", card: { id: id(9) } });
    expect(await next("lang", { exclude: id(9) })).toMatchObject({ source: "new", card: { id: id(5) } });
  });

  it("bookmarking an unseen card does not consume it", async () => {
    await importCards(db, srsDeck(1));
    await applyReview(db, { card_id: id(0), action: "bookmark", value: true });
    expect(await deck("lang")).toMatchObject({ learning: 0, new: 1 });
    expect(await next("lang")).toMatchObject({ source: "new", card: { id: id(0), bookmarked: true } });
  });

  it("rejects unknown cards and decks", async () => {
    await expect(good("missing")).rejects.toMatchObject({ status: 404 });
    await expect(next("missing")).rejects.toMatchObject({ status: 404 });
  });
});

describe("browse decks", () => {
  it("serves only unseen cards; Next marks them seen", async () => {
    await importCards(db, browseDeck());
    const seen = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const n = await next("quiz");
      expect(n.source).toBe("new");
      expect(seen.has(n.card!.id)).toBe(false);
      seen.add(n.card!.id);
      expect(await good(n.card!.id)).toMatchObject({ streak: 0, due_at: null, learned: false });
    }
    expect((await next("quiz")).card).toBeNull();
    expect(await deck("quiz")).toMatchObject({ learning: 0, new: 0, learned: 0 });
    expect((await db.select().from(reviewLog)).map((l) => l.answer)).toEqual(["seen", "seen", "seen"]);
  });

  it("filters by category and season", async () => {
    await importCards(db, browseDeck());
    const ids = async (f: { category?: string; season?: string }) => {
      const out = new Set<string>();
      for (let i = 0; i < 20; i++) out.add((await next("quiz", f)).card!.id);
      return [...out].sort();
    };
    expect(await ids({ category: "science" })).toEqual(["q1", "q3"]);
    expect(await ids({ season: "S1" })).toEqual(["q1", "q2"]);
    expect(await ids({ category: "science", season: "S2" })).toEqual(["q3"]);
  });

  it("Again brings a card into the Again/Good loop", async () => {
    await importCards(db, browseDeck());
    expect(await again("q1")).toMatchObject({ streak: 0, learned: false });
    expect(await deck("quiz")).toMatchObject({ learning: 1, new: 2 });
    // Once learning, Good counts towards learning it instead of just marking it seen.
    expect(await good("q1")).toMatchObject({ streak: 1 });
    expect((await next("quiz", { category: "science", season: "S1" })).card).toMatchObject({
      id: "q1",
      learning: true,
    });
  });
});

describe("seed data", () => {
  it("imports 20 cards with every media type and a full study loop works", async () => {
    await importCards(db, SEED);
    const all = SEED.cards;
    expect(all).toHaveLength(20);
    const types = new Set(all.flatMap((c) => c.media.map((m) => m.type)));
    expect(types).toEqual(new Set(["image", "video", "audio"]));

    const decks = await listDecks(db);
    expect(decks.map((d) => [d.id, d.kind, d.parent, d.new])).toEqual([
      ["demo-spanish-basics", "srs", "demo-spanish", 7],
      ["demo-spanish", "srs", null, 12],
      ["demo-trivia", "browse", null, 8],
      ["demo-spanish-media", "srs", "demo-spanish", 5],
    ]);

    // Media cards are never skipped, and Good on everything eventually learns the whole deck.
    await study("demo-spanish", 100);
    expect(await deck("demo-spanish")).toMatchObject({ learning: 0, new: 0, learned: 12 });
  });
});

describe("sub-decks", () => {
  const nested = (perSub: number) =>
    parseImportPayload({
      decks: [
        { id: "lang", name: "Lang", kind: "srs" },
        { id: "lang:a", name: "A", parent: "lang" },
        { id: "lang:b", name: "B", parent: "lang" },
      ],
      cards: ["a", "b"].flatMap((sub) =>
        Array.from({ length: perSub }, (_, i) => ({
          id: `lang:${sub}:${String(i).padStart(2, "0")}`,
          deck: `lang:${sub}`,
          front: `${sub}${i}`,
          back: `${sub}${i}`,
        })),
      ),
    });

  it("a parent's counts include its sub-decks", async () => {
    await importCards(db, nested(3));
    await again("lang:a:00");
    await again("lang:b:00");
    const byId = Object.fromEntries((await listDecks(db)).map((d) => [d.id, d]));
    expect(byId["lang"]).toMatchObject({ parent: null, learning: 2, new: 4, total: 6 });
    expect(byId["lang:a"]).toMatchObject({ parent: "lang", learning: 1, new: 2, total: 3 });
    expect(byId["lang:b"]).toMatchObject({ parent: "lang", learning: 1, new: 2, total: 3 });
  });

  it("studying a parent draws from all sub-decks; a sub-deck only from itself", async () => {
    await importCards(db, nested(2));
    const fromParent = new Set<string>();
    for (;;) {
      const n = await next("lang");
      if (!n.card || n.source !== "new") break;
      fromParent.add(n.card.deck);
      await good(n.card.id);
    }
    expect(fromParent).toEqual(new Set(["lang:a", "lang:b"]));

    await importCards(db, nested(4));
    expect((await next("lang:b")).card!.deck).toBe("lang:b");
  });
});
