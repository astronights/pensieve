import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseImportPayload } from "@/lib/import";
import { loadFixes } from "../scripts/anki/convert";
import type { AnkiCollection } from "../scripts/anki/read";
import { readAnkiExport } from "../scripts/anki/read";
import {
  convertCollection,
  escapeMarkdown,
  htmlToText,
  levelName,
  mergeMeanings,
  placeDeck,
  wordKey,
} from "../scripts/anki/transform";

describe("field cleanup", () => {
  it("decodes HTML to plain text", () => {
    expect(htmlToText("(women&#x27;s) sandals")).toBe("(women's) sandals");
    expect(htmlToText("fire&nbsp;(hi / ka)")).toBe("fire (hi / ka)");
    expect(htmlToText("<div>水</div>")).toBe("水");
    expect(htmlToText("water<br><i>mizu</i>")).toBe("water\nmizu");
    expect(htmlToText("  бейсбо́лка ")).toBe("бейсбо́лка");
  });

  it("keeps vocabulary literal in Markdown", () => {
    expect(escapeMarkdown("у (+ gen)")).toBe("у (+ gen)");
    expect(escapeMarkdown("1. first")).toBe("1\\. first");
    expect(escapeMarkdown("- dash")).toBe("\\- dash");
    expect(escapeMarkdown("*star* _under_ [x]")).toBe("\\*star\\* \\_under\\_ \\[x\\]");
    expect(escapeMarkdown("Дава́й ...")).toBe("Дава́й ...");
  });
});

describe("deck placement", () => {
  it("names the level", () => {
    expect(levelName("Между нами Unit 1")).toBe("Unit 1");
    expect(levelName("Complete Swedish - Chapter 3")).toBe("Chapter 3");
    expect(levelName("HSK1")).toBe("HSK 1");
  });

  it("splits language, level and topic", () => {
    expect(placeDeck("Russian - Между нами Unit 2::Housing")).toEqual({
      language: "Russian",
      level: "Unit 2",
      topic: "Housing",
    });
    expect(placeDeck("Mandarin - HSK1::Day 1 - Ordering Drinks")).toEqual({
      language: "Mandarin",
      level: "HSK 1",
      topic: "Day 1 - Ordering Drinks",
    });
    expect(placeDeck("Japanese::Vocab::N5")).toMatch(/3 level/);
    expect(placeDeck("Spanish::Verbs")).toMatch(/no " - "/);
  });
});

/** A small collection laid out like the real export. */
function collection(): AnkiCollection {
  const decks = [
    "Swedish - Complete Swedish - Chapter 10::Food",
    "Swedish - Complete Swedish - Chapter 2::Numbers 0-100",
    "Swedish - Complete Swedish - Chapter 2::Family",
    "Mandarin - HSK1::Day 2 - Ordering Food & Paying",
    "Mandarin - HSK1::Day 1 - Ordering Drinks",
  ];
  const notes: [number, string, string][] = [
    [1, "fjorton", "14"],
    [2, "bror", "brother"],
    [0, "ett bord", "a table"],
    [4, "你好", "nǐ hǎo"],
    [3, "水", "shuǐ"],
    [2, "mor", "mother"],
  ];
  return {
    format: "anki21b",
    mediaFiles: 0,
    decks: decks.map((name, i) => ({ id: String(i), name })),
    noteTypes: [{ id: "b", name: "Basic", kind: "standard", fields: ["Front", "Back"], templates: [] }],
    notes: notes.map(([, front, back], i) => ({
      id: String(i),
      guid: `g${i}`,
      typeId: "b",
      fields: [front, back],
      tags: ["x"],
    })),
    cards: notes.map(([deck], i) => ({ id: `c${i}`, noteId: String(i), deckId: String(deck), ord: 0 })),
  };
}

describe("convertCollection", () => {
  const fixes = { Mandarin: { meanings: { 你好: "hello", 水: "water" } } };

  it("makes one deck per language with a sub-deck per level, in natural order", () => {
    const { payload, issues } = convertCollection(collection(), fixes);
    expect(issues).toEqual([]);
    expect(payload.decks).toEqual([
      { id: "anki:mandarin", name: "Mandarin", kind: "srs", parent: null },
      { id: "anki:mandarin:hsk-1", name: "HSK 1", parent: "anki:mandarin" },
      { id: "anki:swedish", name: "Swedish", kind: "srs", parent: null },
      { id: "anki:swedish:chapter-2", name: "Chapter 2", parent: "anki:swedish" },
      { id: "anki:swedish:chapter-10", name: "Chapter 10", parent: "anki:swedish" },
    ]);
    // The app accepts it as an import.
    expect(() => parseImportPayload(payload)).not.toThrow();
  });

  it("orders cards by level, topic, then Anki order; keeps the topic as category", () => {
    const { payload } = convertCollection(collection(), fixes);
    expect(payload.cards.map((c) => [c.front, c.category])).toEqual([
      ["你好", "Day 1 - Ordering Drinks"],
      ["水", "Day 2 - Ordering Food & Paying"],
      ["bror", "Family"],
      ["mor", "Family"],
      ["fjorton", "Numbers 0-100"],
      ["ett bord", "Food"],
    ]);
    const ids = payload.cards.map((c) => c.id);
    expect([...ids].sort()).toEqual(ids);
    expect(payload.cards[0]).toMatchObject({ id: "anki:mandarin:01:01:0003", deck: "anki:mandarin:hsk-1", tags: [] });
  });

  it("adds the fixed meaning under the pinyin, and keeps the raw note", () => {
    const { payload } = convertCollection(collection(), fixes);
    const hello = payload.cards.find((c) => c.front === "你好")!;
    expect(hello.back).toBe("nǐ hǎo\nhello");
    expect(hello.meta).toMatchObject({ raw: { guid: "g3", fields: { Front: "你好", Back: "nǐ hǎo" }, tags: ["x"] } });
  });

  it("reports notes it can't place instead of guessing", async () => {
    const missing = convertCollection(collection(), { Mandarin: { meanings: { 水: "water" } } });
    expect(missing.issues).toEqual([
      { deck: "Mandarin - HSK1::Day 1 - Ordering Drinks", front: "你好", problem: "no meaning in the fixes file" },
    ]);
    expect(missing.payload.cards).toHaveLength(5);

    // The fixture uses other layouts (3 levels, no " - ", other note types): all reported.
    const fixture = await readAnkiExport(path.join(__dirname, "fixtures", "anki", "modern.apkg"));
    const { payload, issues } = convertCollection(fixture);
    expect(payload.cards).toHaveLength(0);
    expect(issues).toHaveLength(fixture.notes.length);
  });
});

describe("fixes", () => {
  it("has a non-empty meaning for every Mandarin entry", async () => {
    const meanings = (await loadFixes()).Mandarin.meanings!;
    expect(Object.keys(meanings)).toHaveLength(98);
    for (const [front, meaning] of Object.entries(meanings)) expect(meaning.trim(), front).not.toBe("");
  });
});

describe("duplicates", () => {
  it("treats spellings that differ only in stress marks, case or end punctuation as the same word", () => {
    expect(wordKey("толсто́вка")).toBe(wordKey("толстовка"));
    expect(wordKey("Извини́те.")).toBe(wordKey("Извини́те"));
    expect(wordKey("почему́?")).toBe(wordKey("почему́"));
    expect(wordKey("En kopp kaffe")).toBe(wordKey("en kopp kaffe"));
    // Different letters are different words.
    expect(wordKey("всё")).not.toBe(wordKey("все"));
    expect(wordKey("far")).not.toBe(wordKey("får"));
    expect(wordKey("var")).not.toBe(wordKey("vår"));
  });

  it("joins distinct meanings and drops repeated or covered ones", () => {
    expect(mergeMeanings(["why?", "why?"])).toBe("why?");
    expect(mergeMeanings(["Excuse me", "Excuse (me)."])).toBe("Excuse me");
    expect(mergeMeanings(["Hoodie", "hoodie, sweatshirt"])).toBe("hoodie, sweatshirt");
    expect(mergeMeanings(["No", "there is no, there are no"])).toBe("No; there is no, there are no");
    expect(mergeMeanings(["how?", "like (in comparison)"])).toBe("how?; like (in comparison)");
  });

  it("merges a word that appears twice in a language into one card where it first comes up", () => {
    const col = collection();
    col.decks.push({ id: "5", name: "Russian - Между нами Unit 4::Function Words" });
    col.decks.push({ id: "6", name: "Russian - Между нами Unit 1::Greetings & Phrases" });
    col.notes.push(
      { id: "a", guid: "ga", typeId: "b", fields: ["нет", "there is no"], tags: [] },
      { id: "b", guid: "gb", typeId: "b", fields: ["Нет", "No"], tags: [] },
      { id: "c", guid: "gc", typeId: "b", fields: ["Bror", "brother"], tags: [] },
    );
    col.cards.push(
      { id: "ca", noteId: "a", deckId: "5", ord: 0 },
      { id: "cb", noteId: "b", deckId: "6", ord: 0 },
      // Same word as "bror" in another chapter, but a different language from Russian.
      { id: "cc", noteId: "c", deckId: "0", ord: 0 },
    );
    const { payload, stats } = convertCollection(col, { Mandarin: { meanings: { 你好: "hello", 水: "water" } } });
    const net = payload.cards.filter((c) => wordKey(c.front) === "нет");
    expect(net).toHaveLength(1);
    expect(net[0]).toMatchObject({
      deck: "anki:russian:unit-1",
      category: "Greetings & Phrases",
      back: "No; there is no",
    });
    expect(net[0].meta).toMatchObject({ raw: { guid: "gb", duplicates: [{ guid: "ga" }] } });
    // Unit 4 lost its only card, so it isn't created.
    expect(payload.decks.map((d) => d.id)).not.toContain("anki:russian:unit-4");
    expect(payload.cards.filter((c) => wordKey(c.front) === "bror")).toHaveLength(1);
    expect(stats.merged.map((m) => m.front)).toEqual(expect.arrayContaining(["Нет", "bror"]));
  });
});
