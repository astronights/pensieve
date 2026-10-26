import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import { importCards, parseImportPayload } from "@/lib/import";
import { applyReview } from "@/lib/review";
import { searchCards, searchTerms } from "@/lib/search";
import { createTestDb } from "./helpers/db";

let db: DB;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await importCards(
    db,
    parseImportPayload({
      decks: [
        { id: "ru", name: "Russian", kind: "srs" },
        { id: "ru:1", name: "Unit 1", parent: "ru" },
        { id: "quiz", name: "Quiz", kind: "srs" },
      ],
      cards: [
        { id: "ru:1:a", deck: "ru:1", front: "бейсбо́лка", back: "baseball cap", category: "Clothing" },
        { id: "ru:1:b", deck: "ru:1", front: "ку́ртка", back: "jacket", category: "Clothing" },
        {
          id: "quiz:1",
          deck: "quiz",
          front: "Which river is **longest**?",
          back: "The **Nile**",
          tags: ["S1"],
          meta: { notes: "Accept: Nil", explanation: "Flows through Egypt", raw: { secret: "zebra" } },
        },
        {
          id: "quiz:2",
          deck: "quiz",
          front: "Which 100% cotton cap?",
          back: "A \\*baseball\\* cap",
          meta: { info: [{ label: "Topic", value: "Sport" }] },
        },
      ],
    }),
  );
});
afterEach(async () => close());

const ids = async (q: string) => (await searchCards(db, q)).cards.map((c) => c.id);

describe("search", () => {
  it("splits keywords and keeps quoted phrases together", () => {
    expect(searchTerms(`  Baseball  "cotton cap" baseball `)).toEqual(["baseball", "cotton cap"]);
    expect(searchTerms("")).toEqual([]);
  });

  it("finds cards containing every keyword, anywhere on the card", async () => {
    expect(await ids("cap")).toEqual(["quiz:2", "ru:1:a"]);
    expect(await ids("baseball clothing")).toEqual(["ru:1:a"]);
    expect(await ids("egypt")).toEqual(["quiz:1"]); // explanation
    expect(await ids("nil s1")).toEqual(["quiz:1"]); // notes and tags
    expect(await ids("sport")).toEqual(["quiz:2"]); // info lines
    expect(await ids("zebra")).toEqual([]); // the raw source record isn't searched
    expect(await ids(`"cotton cap"`)).toEqual(["quiz:2"]);
    expect(await ids(`"cap cotton"`)).toEqual([]);
  });

  it("ignores case, Russian stress marks and Markdown", async () => {
    expect(await ids("БЕЙСБОЛКА")).toEqual(["ru:1:a"]);
    expect(await ids("куртка")).toEqual(["ru:1:b"]);
    expect(await ids("*baseball* cotton")).toEqual(["quiz:2"]);
    expect(await ids("100%")).toEqual(["quiz:2"]);
    expect(await ids("_")).toEqual([]);
  });

  it("says where each card is and how far along it is", async () => {
    await applyReview(db, { card_id: "ru:1:a", answer: "good" });
    const { total, cards } = await searchCards(db, "cap");
    expect(total).toBe(2);
    expect(cards.find((c) => c.id === "ru:1:a")).toMatchObject({ deckName: "Russian › Unit 1", status: "learning" });
    expect(cards.find((c) => c.id === "quiz:2")).toMatchObject({ deckName: "Quiz", status: "new" });
    expect(await searchCards(db, "   ")).toEqual({ total: 0, cards: [] });
  });
});
