import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import { answerOffline, listDecksOffline, nextCardOffline, searchOffline } from "@/lib/engine";
import { importCards, parseImportPayload } from "@/lib/import";
import { listDecks, nextCard } from "@/lib/queue";
import { applyReview } from "@/lib/review";
import { searchCards } from "@/lib/search";
import { updateSettings } from "@/lib/settings";
import type { Snapshot } from "@/lib/snapshot";
import { answerTime, applyOfflineAnswers, buildSnapshot, parseOfflineAnswers } from "@/lib/sync";
import { createTestDb } from "./helpers/db";

let db: DB;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => close());

/** Small deterministic random numbers, so a failure can be replayed. */
function prng(seed: number) {
  return () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
}

// Ids whose order differs between byte order and language-aware collations, so the test catches a
// tie broken differently on the phone.
const IDS = ["x-10", "x_2", "X1", "x.3", "x 4", "y", "Y-0", "a:b", "a-b", "ab"];

async function seed() {
  await importCards(
    db,
    parseImportPayload({
      decks: [
        { id: "lang", name: "Lang", kind: "srs" },
        { id: "lang:a", name: "A", parent: "lang" },
        { id: "lang:b", name: "B", parent: "lang" },
        { id: "quiz", name: "Quiz", kind: "browse" },
      ],
      cards: [
        ...IDS.map((id, i) => ({ id: `lang:a:${id}`, deck: "lang:a", front: `fa${i}`, back: `ba${i}` })),
        ...IDS.map((id, i) => ({
          id: `lang:b:${id}`,
          deck: "lang:b",
          front: `fb${i}`,
          back: `bb${i}`,
          category: i % 2 ? "odd" : "even",
        })),
        ...IDS.slice(0, 5).map((id, i) => ({ id: `quiz:${id}`, deck: "quiz", front: `q${i}`, back: `answer ${i}` })),
      ],
    }),
  );
  // A second import later: newer cards sort after older ones whatever their ids.
  await new Promise((r) => setTimeout(r, 5));
  await importCards(
    db,
    parseImportPayload({
      decks: [{ id: "lang:a", name: "A", parent: "lang" }],
      cards: ["0", "!", "Z"].map((id, i) => ({
        id: `lang:a:${id}late`,
        deck: "lang:a",
        front: `late${i}`,
        back: `l${i}`,
      })),
    }),
  );
}

const essentials = (s: Snapshot) => ({
  decks: Object.fromEntries(s.decks.map((d) => [d.id, d.answers])),
  states: Object.fromEntries(Object.entries(s.states).map(([id, st]) => [id, { ...st, bookmarked: undefined }])),
});

describe("offline engine matches the server", () => {
  it("picks the same cards and ends in the same state over a long random session", async () => {
    await seed();
    await updateSettings(db, { again_gap: 2, good_gap: 3, review_gap: 6 });
    const snap = await buildSnapshot(db);
    const rand = prng(42);
    const decks = ["lang", "lang:a", "lang:b"];
    let deck = "lang";
    for (let step = 0; step < 600; step++) {
      if (rand() < 0.05) deck = decks[Math.floor(rand() * decks.length)];
      const filters = rand() < 0.1 ? { category: "odd" } : rand() < 0.1 ? { exclude: "lang:a:x_2" } : {};
      const server = await nextCard(db, deck, filters);
      const local = nextCardOffline(snap, deck, filters);
      expect(local, `step ${step} (${deck})`).toEqual(server);
      if (!server.card) continue;
      const answer = rand() < 0.7 ? "good" : "again";
      await applyReview(db, { card_id: server.card.id, answer });
      answerOffline(snap, server.card.id, answer);
      if (step % 100 === 99) expect(essentials(snap)).toEqual(essentials(await buildSnapshot(db)));
    }
    expect(essentials(snap)).toEqual(essentials(await buildSnapshot(db)));
    expect(listDecksOffline(snap)).toEqual(await listDecks(db));
  });

  it("applies browse-deck answers the same way (Next only marks a card seen)", async () => {
    await seed();
    const snap = await buildSnapshot(db);
    const rand = prng(7);
    for (let step = 0; step < 40; step++) {
      const server = await nextCard(db, "quiz", {});
      if (!server.card) break;
      if (server.source !== "new") expect(nextCardOffline(snap, "quiz").card?.id).toBe(server.card.id);
      const answer = rand() < 0.6 ? "good" : "again";
      await applyReview(db, { card_id: server.card.id, answer });
      answerOffline(snap, server.card.id, answer);
    }
    expect(essentials(snap)).toEqual(essentials(await buildSnapshot(db)));
  });

  it("searches the same as the server", async () => {
    await seed();
    const snap = await buildSnapshot(db);
    for (const q of ["answer", "ANSWER 3", "fa1", "even", `"answer 2"`, "nothing"]) {
      const server = await searchCards(db, q);
      expect(searchOffline(snap, q), q).toEqual(server);
    }
  });
});

describe("sync", () => {
  it("only resends cards when they changed", async () => {
    await seed();
    const full = await buildSnapshot(db);
    expect(full.cards).toHaveLength(28);
    expect((await buildSnapshot(db, full.cardsVersion)).cards).toBeUndefined();
    await importCards(
      db,
      parseImportPayload({ cards: [{ id: "lang:a:y", deck: "lang:a", front: "changed", back: "b" }] }),
    );
    expect((await buildSnapshot(db, full.cardsVersion)).cards).toHaveLength(28);
  });

  it("replays offline answers in order, once, and they match what the phone worked out", async () => {
    await seed();
    const snap = await buildSnapshot(db);
    const answers = [];
    for (let i = 0; i < 25; i++) {
      const { card } = nextCardOffline(snap, "lang");
      const answer = i % 4 === 0 ? "again" : "good";
      answerOffline(snap, card!.id, answer);
      answers.push({ card_id: card!.id, answer, at: Date.now() - 1000 + i });
    }
    expect(await applyOfflineAnswers(db, parseOfflineAnswers({ answers }))).toEqual({ applied: 25, skipped: 0 });
    // Sent again (the reply was lost): nothing is counted twice.
    expect(await applyOfflineAnswers(db, parseOfflineAnswers({ answers }))).toEqual({ applied: 0, skipped: 25 });
    expect(essentials(await buildSnapshot(db))).toEqual(essentials(snap));
  });

  it("validates answers and their times", () => {
    expect(() => parseOfflineAnswers({})).toThrow();
    expect(() => parseOfflineAnswers({ answers: [{ card_id: "x", answer: "maybe", at: 1 }] })).toThrow();
    const now = Date.UTC(2026, 0, 10);
    expect(answerTime(now - 1000, now).getTime()).toBe(now - 1000);
    expect(answerTime(now + 86_400_000, now).getTime()).toBe(now); // in the future: server time
    expect(answerTime("soon", now).getTime()).toBe(now);
  });
});
