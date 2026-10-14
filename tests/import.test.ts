import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import { cards, cardState, decks } from "@/db/schema";
import { HttpError } from "@/lib/errors";
import { importCards, parseImportPayload } from "@/lib/import";
import { applyReview } from "@/lib/review";
import { createTestDb } from "./helpers/db";

const card = (over: Record<string, unknown> = {}) => ({
  id: "zql:S1:G3:2:5",
  deck: "zql",
  front: "front",
  back: "back",
  ...over,
});

describe("parseImportPayload", () => {
  it("accepts a bare array and fills defaults", () => {
    const p = parseImportPayload([card()]);
    expect(p.decks).toEqual([]);
    expect(p.cards[0]).toEqual({
      id: "zql:S1:G3:2:5",
      deck: "zql",
      front: "front",
      back: "back",
      tags: [],
      category: null,
      media: [],
      meta: null,
    });
  });

  it("accepts { decks, cards }; kind and parent are optional", () => {
    const p = parseImportPayload({ decks: [{ id: "zql" }, { id: "zql:S1", parent: "zql" }], cards: [card()] });
    expect(p.decks).toEqual([
      { id: "zql", name: "zql", parent: null },
      { id: "zql:S1", name: "zql:S1", parent: "zql" },
    ]);
  });

  it.each([
    ["not an array", { foo: 1 }],
    ["missing id", [card({ id: "" })]],
    ["bad tags", [card({ tags: [1] })]],
    ["bad media type", [card({ media: [{ type: "pdf", url: "https://x/y", side: "front" }] })]],
    ["bad media side", [card({ media: [{ type: "image", url: "https://x/y", side: "middle" }] })]],
    ["non-http media", [card({ media: [{ type: "image", url: "javascript:alert(1)", side: "front" }] })]],
    ["bad deck kind", { decks: [{ id: "zql", kind: "other" }], cards: [] }],
    ["duplicate ids", [card(), card()]],
    ["duplicate deck ids", { decks: [{ id: "a" }, { id: "a" }], cards: [] }],
    ["self-parent", { decks: [{ id: "a", parent: "a" }], cards: [] }],
    ["bad parent", { decks: [{ id: "a", parent: 3 }], cards: [] }],
  ])("rejects %s", (_, body) => {
    expect(() => parseImportPayload(body)).toThrow(HttpError);
  });
});

describe("importCards", () => {
  let db: DB;
  let close: () => Promise<void>;
  beforeEach(async () => ({ db, close } = await createTestDb()));
  afterEach(async () => close());

  it("creates decks implicitly and upserts cards", async () => {
    await importCards(db, parseImportPayload([card(), card({ id: "b", deck: "other" })]));
    expect((await db.select().from(decks)).map((d) => d.id).sort()).toEqual(["other", "zql"]);
    expect(await db.select().from(cards)).toHaveLength(2);
  });

  it("re-importing updates content but keeps study progress", async () => {
    await importCards(db, parseImportPayload([card()]));
    await applyReview(db, { card_id: "zql:S1:G3:2:5", answer: "good" });
    const before = (await db.select().from(cardState))[0];

    await importCards(
      db,
      parseImportPayload([
        card({ front: "new front", media: [{ type: "audio", url: "https://a/b.mp3", side: "back" }] }),
      ]),
    );
    const [c] = await db.select().from(cards).where(eq(cards.id, "zql:S1:G3:2:5"));
    expect(c.front).toBe("new front");
    expect(c.media).toEqual([{ type: "audio", url: "https://a/b.mp3", side: "back" }]);
    expect((await db.select().from(cardState))[0]).toEqual(before);
  });

  it("updates kind of explicitly listed decks but not implicit ones", async () => {
    await importCards(db, parseImportPayload({ decks: [{ id: "zql", name: "ZQL", kind: "browse" }], cards: [] }));
    await importCards(db, parseImportPayload([card()]));
    expect((await db.select().from(decks))[0]).toEqual({ id: "zql", name: "ZQL", kind: "browse", parent: null });
  });
});

describe("sub-decks", () => {
  let db: DB;
  let close: () => Promise<void>;
  beforeEach(async () => ({ db, close } = await createTestDb()));
  afterEach(async () => close());

  const imp = (body: unknown) => importCards(db, parseImportPayload(body));
  const deckRows = async () =>
    Object.fromEntries((await db.select().from(decks)).map((d) => [d.id, { kind: d.kind, parent: d.parent }]));

  it("creates a parent and sub-decks in one import; sub-decks take the parent's kind", async () => {
    await imp({
      decks: [
        { id: "quiz:S1", name: "Season 1", parent: "quiz" },
        { id: "quiz", name: "Quiz", kind: "browse" },
      ],
      cards: [card({ id: "q1", deck: "quiz:S1" })],
    });
    expect(await deckRows()).toEqual({
      quiz: { kind: "browse", parent: null },
      "quiz:S1": { kind: "browse", parent: "quiz" },
    });
  });

  it("allows a sub-deck under an existing deck", async () => {
    await imp({ decks: [{ id: "zql", kind: "srs" }], cards: [] });
    await imp({ decks: [{ id: "zql:S1", parent: "zql" }], cards: [] });
    expect((await deckRows())["zql:S1"]).toEqual({ kind: "srs", parent: "zql" });
  });

  it.each([
    ["a missing parent", { decks: [{ id: "a", parent: "nope" }], cards: [] }, /doesn't exist/],
    [
      "a second level",
      { decks: [{ id: "a" }, { id: "b", parent: "a" }, { id: "c", parent: "b" }], cards: [] },
      /only one level/,
    ],
    [
      "a different kind from the parent",
      { decks: [{ id: "a", kind: "browse" }, { id: "b", kind: "srs", parent: "a" }], cards: [] },
      /parent's kind/,
    ],
  ])("rejects %s", async (_, body, message) => {
    await expect(imp(body)).rejects.toThrow(message);
    expect(await db.select().from(decks)).toHaveLength(0); // nothing half-written
  });

  it("won't nest a deck that already has sub-decks", async () => {
    await imp({ decks: [{ id: "a" }, { id: "b", parent: "a" }, { id: "x" }], cards: [] });
    await expect(imp({ decks: [{ id: "a", parent: "x" }], cards: [] })).rejects.toThrow(/has sub-decks/);
  });

  it("changing a parent's kind updates its existing sub-decks", async () => {
    await imp({ decks: [{ id: "a", kind: "srs" }, { id: "b", parent: "a" }], cards: [] });
    await imp({ decks: [{ id: "a", kind: "browse" }], cards: [] });
    expect(await deckRows()).toEqual({
      a: { kind: "browse", parent: null },
      b: { kind: "browse", parent: "a" },
    });
  });

  it("re-importing a top-level deck without kind keeps its kind", async () => {
    await imp({ decks: [{ id: "a", kind: "browse" }], cards: [] });
    await imp({ decks: [{ id: "a", name: "Renamed" }], cards: [] });
    expect((await db.select().from(decks))[0]).toMatchObject({ name: "Renamed", kind: "browse" });
  });
});
