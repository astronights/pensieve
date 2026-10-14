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

  it("accepts { decks, cards } and defaults deck kind to srs", () => {
    const p = parseImportPayload({ decks: [{ id: "zql" }], cards: [card()] });
    expect(p.decks).toEqual([{ id: "zql", name: "zql", kind: "srs" }]);
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
    await applyReview(db, { card_id: "zql:S1:G3:2:5", rating: 3 });
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
    expect((await db.select().from(decks))[0]).toEqual({ id: "zql", name: "ZQL", kind: "browse" });
  });
});
