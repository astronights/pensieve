import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import { cardState, reviewLog, settings as settingsTable } from "@/db/schema";
import { HttpError } from "@/lib/errors";
import { importCards, parseImportPayload } from "@/lib/import";
import { listDecks, nextCard } from "@/lib/queue";
import { ADD_TO_REVIEW_DELAY_MS, applyReview, parseReviewInput } from "@/lib/review";
import { SEED } from "@/lib/seed-data";
import { getSettings, updateSettings } from "@/lib/settings";
import { createTestDb } from "./helpers/db";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = new Date("2026-03-10T12:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

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

const deck = async (id: string, now = T0) => (await listDecks(db, now)).find((d) => d.id === id)!;

describe("settings", () => {
  it("uses defaults and validates updates", async () => {
    expect(await getSettings(db)).toEqual({ daily_new_limit: 15, desired_retention: 0.9, timezone: "UTC" });
    expect(await updateSettings(db, { desired_retention: 0.85 })).toMatchObject({ desired_retention: 0.85 });
    await expect(updateSettings(db, { desired_retention: 2 })).rejects.toThrow(HttpError);
    await expect(updateSettings(db, { timezone: "Mars/Olympus" })).rejects.toThrow(HttpError);
    await expect(updateSettings(db, { nope: 1 })).rejects.toThrow(HttpError);
  });

  it("caches reads and refreshes after an update", async () => {
    await getSettings(db);
    // A write that bypasses updateSettings is not seen while cached...
    await db.insert(settingsTable).values({ key: "daily_new_limit", value: 3 });
    expect((await getSettings(db)).daily_new_limit).toBe(15);
    // ...but updateSettings invalidates the cache.
    expect((await updateSettings(db, { timezone: "Europe/London" })).daily_new_limit).toBe(3);
  });
});

describe("parseReviewInput", () => {
  it("validates ratings and actions", () => {
    expect(parseReviewInput({ card_id: "a", rating: 3 })).toEqual({ card_id: "a", rating: 3 });
    expect(parseReviewInput({ card_id: "a", action: "add_to_review" })).toEqual({
      card_id: "a",
      action: "add_to_review",
    });
    expect(() => parseReviewInput({ card_id: "a", rating: 5 })).toThrow(HttpError);
    expect(() => parseReviewInput({ card_id: "a", rating: "3" })).toThrow(HttpError);
    expect(() => parseReviewInput({ rating: 3 })).toThrow(HttpError);
    expect(() => parseReviewInput({ card_id: "a" })).toThrow(HttpError);
  });
});

describe("SRS decks", () => {
  it("serves new cards in import order up to the daily cap", async () => {
    await importCards(db, srsDeck(20));
    expect(await deck("lang")).toMatchObject({ due: 0, new: 15, unseen: 20 });

    for (let i = 0; i < 15; i++) {
      const next = await nextCard(db, "lang", {}, at(i * 1000));
      expect(next.source).toBe("new");
      expect(next.card!.id).toBe(`lang:${String(i).padStart(3, "0")}`);
      await applyReview(db, { card_id: next.card!.id, rating: 4 }, at(i * 1000));
    }
    expect(await deck("lang", at(HOUR))).toMatchObject({ new: 0, unseen: 5 });
    expect((await nextCard(db, "lang", {}, at(HOUR))).card).toBeNull();

    // Next UTC day the cap resets.
    expect(await deck("lang", at(DAY))).toMatchObject({ new: 5 });
  });

  it("honours the configured timezone for the daily reset", async () => {
    await importCards(db, srsDeck(3));
    await updateSettings(db, { daily_new_limit: 1, timezone: "America/New_York" });
    // 12:00Z = 08:00 New York. Review one card.
    await applyReview(db, { card_id: "lang:000", rating: 4 }, T0);
    // 03:30Z next day = 23:30 New York, still the same local day.
    expect(await deck("lang", at(15.5 * HOUR))).toMatchObject({ new: 0 });
    // 04:30Z next day = 00:30 New York, a new local day.
    expect(await deck("lang", at(16.5 * HOUR))).toMatchObject({ new: 1 });
  });

  it("runs FSRS, updates card_state and appends review_log", async () => {
    await importCards(db, srsDeck(1));
    const r1 = await applyReview(db, { card_id: "lang:000", rating: 3 }, T0);
    expect(r1).toMatchObject({ scheduled: true, state: "learning", deck: "lang" });

    const [s1] = await db.select().from(cardState);
    expect(s1).toMatchObject({ reps: 1, lapses: 0, inReviewQueue: false });
    expect(s1.lastReview).toEqual(T0);
    expect(s1.due.getTime()).toBeGreaterThan(T0.getTime());

    // Graduate it, then fail it.
    const r2 = await applyReview(db, { card_id: "lang:000", rating: 3 }, s1.due);
    expect(r2.state).toBe("review");
    const [s2] = await db.select().from(cardState);
    const r3 = await applyReview(db, { card_id: "lang:000", rating: 1 }, s2.due);
    expect(r3.state).toBe("relearning");

    const logs = await db.select().from(reviewLog).orderBy(reviewLog.id);
    expect(logs.map((l) => [l.rating, l.stateBefore])).toEqual([
      [3, "new"],
      [3, "learning"],
      [1, "review"],
    ]);
    expect(logs[0].dueBefore).toBeNull();
    expect(logs[1].dueBefore).toEqual(s1.due);
    expect(logs[2].stability).toBeGreaterThan(0);
    expect((await db.select().from(cardState))[0]).toMatchObject({ reps: 3, lapses: 1 });
  });

  it("shows due reviews before new cards, oldest due first", async () => {
    await importCards(db, srsDeck(3));
    await applyReview(db, { card_id: "lang:001", rating: 1 }, T0); // due ~1 min
    await applyReview(db, { card_id: "lang:002", rating: 1 }, at(-60_000)); // due earlier
    const later = at(HOUR);
    expect(await deck("lang", later)).toMatchObject({ due: 2, new: 1 });
    const next = await nextCard(db, "lang", {}, later);
    expect(next).toMatchObject({ source: "due", card: { id: "lang:002", state: "learning" } });
  });

  it("exclude skips the current card (used for prefetching)", async () => {
    await importCards(db, srsDeck(3));
    expect((await nextCard(db, "lang", { exclude: "lang:000" }, T0)).card!.id).toBe("lang:001");
    await applyReview(db, { card_id: "lang:001", rating: 1 }, at(-HOUR));
    // A due card is skipped too when excluded.
    expect((await nextCard(db, "lang", {}, T0)).card!.id).toBe("lang:001");
    expect((await nextCard(db, "lang", { exclude: "lang:001" }, T0)).card!.id).toBe("lang:000");
  });

  it("prefetch never goes past the daily new-card cap", async () => {
    await importCards(db, srsDeck(3));
    await updateSettings(db, { daily_new_limit: 1 });
    // lang:000 is the one new card allowed today and is on screen, not yet answered.
    expect(await nextCard(db, "lang", { exclude: "lang:000" }, T0)).toMatchObject({ card: null });
    // Excluding a card that isn't new leaves the cap alone.
    await applyReview(db, { card_id: "lang:002", rating: 1 }, at(-DAY));
    await updateSettings(db, { daily_new_limit: 2 });
    expect((await nextCard(db, "lang", { exclude: "lang:002" }, T0)).card!.id).toBe("lang:000");
  });

  it("learns ahead when nothing else is left", async () => {
    await importCards(db, srsDeck(1));
    await applyReview(db, { card_id: "lang:000", rating: 1 }, T0);
    const next = await nextCard(db, "lang", {}, T0);
    expect(next).toMatchObject({ source: "learn_ahead", card: { id: "lang:000" } });
  });

  it("a desired retention change affects intervals", async () => {
    await importCards(db, srsDeck(2));
    const graduate = async (id: string) => {
      await applyReview(db, { card_id: id, rating: 4 }, T0);
      const [s] = await db.select().from(cardState).where(eq(cardState.cardId, id));
      await applyReview(db, { card_id: id, rating: 3 }, s.due);
      const [after] = await db.select().from(cardState).where(eq(cardState.cardId, id));
      return after.due.getTime() - s.due.getTime();
    };
    await updateSettings(db, { desired_retention: 0.97 });
    const strict = await graduate("lang:000");
    await updateSettings(db, { desired_retention: 0.75 });
    const lax = await graduate("lang:001");
    expect(lax).toBeGreaterThan(strict);
  });

  it("bookmarking an unseen card does not consume it", async () => {
    await importCards(db, srsDeck(1));
    await applyReview(db, { card_id: "lang:000", action: "bookmark", value: true }, T0);
    expect(await deck("lang")).toMatchObject({ due: 0, new: 1 });
    expect(await nextCard(db, "lang", {}, T0)).toMatchObject({
      source: "new",
      card: { id: "lang:000", bookmarked: true },
    });
  });

  it("rejects unknown cards and decks", async () => {
    await expect(applyReview(db, { card_id: "missing", rating: 3 })).rejects.toMatchObject({ status: 404 });
    await expect(nextCard(db, "missing")).rejects.toMatchObject({ status: 404 });
  });
});

describe("browse decks", () => {
  it("serves only unseen cards, marking Good as seen without FSRS", async () => {
    await importCards(db, browseDeck());
    const seen = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const next = await nextCard(db, "quiz", {}, T0);
      expect(next.source).toBe("unseen");
      expect(seen.has(next.card!.id)).toBe(false);
      seen.add(next.card!.id);
      expect(await applyReview(db, { card_id: next.card!.id, rating: 3 }, T0)).toMatchObject({
        scheduled: false,
        in_review_queue: false,
      });
    }
    expect((await nextCard(db, "quiz", {}, at(DAY))).card).toBeNull();
    expect(await deck("quiz", at(DAY))).toMatchObject({ due: 0, new: 0, unseen: 0 });
    expect(await db.select().from(reviewLog)).toHaveLength(0);
  });

  it("filters by category and season", async () => {
    await importCards(db, browseDeck());
    const ids = async (f: { category?: string; season?: string }) => {
      const out = new Set<string>();
      for (let i = 0; i < 20; i++) out.add((await nextCard(db, "quiz", f, T0)).card!.id);
      return [...out].sort();
    };
    expect(await ids({ category: "science" })).toEqual(["q1", "q3"]);
    expect(await ids({ season: "S1" })).toEqual(["q1", "q2"]);
    expect(await ids({ category: "science", season: "S2" })).toEqual(["q3"]);
  });

  it("rating Again brings the card into FSRS and the review queue", async () => {
    await importCards(db, browseDeck());
    const r = await applyReview(db, { card_id: "q1", rating: 1 }, T0);
    expect(r).toMatchObject({ scheduled: true, in_review_queue: true, state: "learning" });
    expect(await db.select().from(reviewLog)).toHaveLength(1);

    const later = at(HOUR);
    expect(await deck("quiz", later)).toMatchObject({ due: 1, unseen: 2 });
    expect(await nextCard(db, "quiz", {}, later)).toMatchObject({ source: "due", card: { id: "q1" } });

    // Once queued, every rating goes through FSRS.
    expect(await applyReview(db, { card_id: "q1", rating: 3 }, later)).toMatchObject({ scheduled: true });
    expect(await db.select().from(reviewLog)).toHaveLength(2);
  });

  it("add to review queues an unseen card for tomorrow", async () => {
    await importCards(db, browseDeck());
    const r = await applyReview(db, { card_id: "q2", action: "add_to_review" }, T0);
    expect(r).toMatchObject({ in_review_queue: true, state: "new", scheduled: false });
    expect(r.due).toEqual(at(ADD_TO_REVIEW_DELAY_MS));

    expect(await deck("quiz", T0)).toMatchObject({ due: 0, unseen: 2 });
    expect(await deck("quiz", at(DAY))).toMatchObject({ due: 1 });
    expect(await nextCard(db, "quiz", {}, at(DAY))).toMatchObject({ source: "due", card: { id: "q2" } });
  });

  it("add to review on a seen card queues it without resetting due for scheduled cards", async () => {
    await importCards(db, browseDeck());
    await applyReview(db, { card_id: "q1", rating: 3 }, T0); // seen only
    await applyReview(db, { card_id: "q1", action: "add_to_review" }, at(HOUR));
    const [s] = await db.select().from(cardState).where(eq(cardState.cardId, "q1"));
    expect(s).toMatchObject({ inReviewQueue: true, due: at(HOUR + ADD_TO_REVIEW_DELAY_MS) });

    await applyReview(db, { card_id: "q3", rating: 1 }, T0); // scheduled via FSRS
    const [before] = await db.select().from(cardState).where(eq(cardState.cardId, "q3"));
    await applyReview(db, { card_id: "q3", action: "add_to_review" }, at(HOUR));
    const [after] = await db.select().from(cardState).where(eq(cardState.cardId, "q3"));
    expect(after.due).toEqual(before.due);
  });
});

describe("seed data", () => {
  it("imports 20 cards with every media type and a full study loop works", async () => {
    await importCards(db, SEED);
    const all = SEED.cards;
    expect(all).toHaveLength(20);
    const types = new Set(all.flatMap((c) => c.media.map((m) => m.type)));
    expect(types).toEqual(new Set(["image", "video", "audio"]));

    const decks = await listDecks(db, T0);
    expect(decks.map((d) => [d.id, d.kind, d.parent, d.unseen])).toEqual([
      ["demo-spanish-basics", "srs", "demo-spanish", 7],
      ["demo-spanish", "srs", null, 12],
      ["demo-trivia", "browse", null, 8],
      ["demo-spanish-media", "srs", "demo-spanish", 5],
    ]);

    // Media cards are never skipped: the SRS loop visits all 12 cards.
    const visited: string[] = [];
    for (;;) {
      const next = await nextCard(db, "demo-spanish", {}, T0);
      if (!next.card || next.source !== "new") break;
      visited.push(next.card.id);
      await applyReview(db, { card_id: next.card.id, rating: 4 }, T0);
    }
    expect(visited).toHaveLength(12);
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
    await applyReview(db, { card_id: "lang:a:00", rating: 1 }, at(-HOUR));
    await applyReview(db, { card_id: "lang:b:00", rating: 1 }, at(-HOUR));
    const byId = Object.fromEntries((await listDecks(db, T0)).map((d) => [d.id, d]));
    expect(byId["lang"]).toMatchObject({ parent: null, due: 2, unseen: 4 });
    expect(byId["lang:a"]).toMatchObject({ parent: "lang", due: 1, unseen: 2 });
    expect(byId["lang:b"]).toMatchObject({ parent: "lang", due: 1, unseen: 2 });
  });

  it("studying a parent draws from all sub-decks; a sub-deck only from itself", async () => {
    await importCards(db, nested(2));
    const seenFromParent = new Set<string>();
    for (;;) {
      const next = await nextCard(db, "lang", {}, T0);
      if (!next.card || next.source !== "new") break;
      seenFromParent.add(next.card.deck);
      await applyReview(db, { card_id: next.card.id, rating: 4 }, T0);
    }
    expect(seenFromParent).toEqual(new Set(["lang:a", "lang:b"]));

    await importCards(db, nested(4));
    const fromB = await nextCard(db, "lang:b", {}, T0);
    expect(fromB.card!.deck).toBe("lang:b");
  });

  it("the daily new-card limit is shared across a parent's sub-decks", async () => {
    await importCards(db, nested(5));
    await updateSettings(db, { daily_new_limit: 3 });
    await applyReview(db, { card_id: "lang:a:00", rating: 4 }, T0);
    await applyReview(db, { card_id: "lang:a:01", rating: 4 }, T0);
    const byId = Object.fromEntries((await listDecks(db, T0)).map((d) => [d.id, d]));
    // 2 of the 3 shared new cards are used, so 1 is left everywhere in the group.
    expect([byId["lang"].new, byId["lang:a"].new, byId["lang:b"].new]).toEqual([1, 1, 1]);

    await applyReview(db, { card_id: "lang:b:00", rating: 4 }, T0);
    expect((await nextCard(db, "lang:b", {}, T0)).card).toBeNull();
    expect((await nextCard(db, "lang", {}, T0)).card).toBeNull();
  });
});
