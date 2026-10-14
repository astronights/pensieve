import { describe, expect, it } from "vitest";
import { parseImportPayload } from "@/lib/import";
import {
  convertAll,
  convertRecord,
  extractMedia,
  fixBoldSpacing,
  htmlToMarkdown,
  normaliseMediaUrl,
  parseGame,
  parseSeason,
  splitAnswer,
  type RawQuestion,
} from "../scripts/zql/transform";

const rec = (over: Partial<RawQuestion> = {}): RawQuestion => ({
  qid: 1,
  season: "ZQL S1",
  gameId: "GW03",
  roundNo: "Round 2 Player 4",
  questionNo: "Question 1",
  player: "Player 4",
  category: "History",
  quad: "Some Topic",
  questionText: "**Which city** is this?",
  answerText: "**Paris**",
  imageurl: "",
  ...over,
});

describe("field parsing", () => {
  it("parses seasons for both leagues", () => {
    expect(parseSeason("ZQL S7")).toMatchObject({ league: { id: "zql" }, season: 7, deckName: "Season 7" });
    expect(parseSeason("Cultish S1")).toMatchObject({ league: { id: "cultish" }, season: 1, deckName: "Season 1" });
    expect(parseSeason("CQL S1 (Cultish S0)")).toMatchObject({
      league: { id: "cultish" },
      season: 0,
      deckName: "Season 0 (CQL S1)",
    });
    expect(parseSeason("Something S2")).toBeNull();
  });

  it("keeps game-week suffixes and pads", () => {
    expect(parseGame("GW08a")).toEqual({ game: 8, suffix: "a", code: "GW08a" });
    expect(parseGame("GW1")).toMatchObject({ code: "GW01" });
    expect(parseGame("Week 3")).toBeNull();
  });
});

describe("media", () => {
  it("normalises imgur page links and gifv, rejects albums", () => {
    expect(normaliseMediaUrl("https://imgur.com/AbC1234")).toEqual({ url: "https://i.imgur.com/AbC1234.jpg" });
    expect(normaliseMediaUrl("https://i.imgur.com/xyz12.gifv")).toEqual({
      url: "https://i.imgur.com/xyz12.mp4",
      type: "video",
    });
    expect(normaliseMediaUrl("https://imgur.com/a/AbC1234")).toBeNull();
    expect(normaliseMediaUrl("javascript:alert(1)")).toBeNull();
  });

  it("extracts img, video/audio (with <source>) and Markdown images", () => {
    const { text, media } = extractMedia(
      'A <img src=\'https://i.imgur.com/a.jpg\' height=\'300px\'> B <video controls><source src="https://i.imgur.com/v.mp4"></video>' +
        ' C <audio src="https://audio.jukehost.co.uk/x.mp3"></audio> D ![](https://i.imgur.com/m.png?1)',
    );
    expect(media).toEqual([
      { type: "video", url: "https://i.imgur.com/v.mp4" },
      { type: "audio", url: "https://audio.jukehost.co.uk/x.mp3" },
      { type: "image", url: "https://i.imgur.com/a.jpg" },
      { type: "image", url: "https://i.imgur.com/m.png?1" },
    ]);
    expect(text.replace(/\s+/g, " ").trim()).toBe("A B C D");
  });
});

describe("text", () => {
  it("converts inline HTML to Markdown", () => {
    expect(htmlToMarkdown("One<br>Two <i>it</i> &amp; <strong>b</strong><hr>Three")).toBe(
      "One\nTwo *it* & **b**\n\n---\n\nThree",
    );
  });

  it("fixes spaces just inside bold markers without pairing across phrases", () => {
    expect(fixBoldSpacing("**Velodrome **(Accept: Any reference to **cycling**)")).toBe(
      "**Velodrome** (Accept: Any reference to **cycling**)",
    );
    expect(fixBoldSpacing("**Swahili** (Accept: **Kiswahili**)")).toBe("**Swahili** (Accept: **Kiswahili**)");
    expect(fixBoldSpacing("odd ** count")).toBe("odd ** count");
  });

  it("splits answer, marking notes and explanation", () => {
    expect(splitAnswer("**Swahili** (Accept: **Kiswahili**); From Arabic “sahil”")).toEqual({
      answer: "**Swahili**",
      notes: "Accept: **Kiswahili**",
      explanation: "From Arabic “sahil”",
    });
    // ";" inside brackets doesn't split; several notes are joined
    expect(splitAnswer("**Tobago** (Grudgingly accept: **T&T**; Do not prompt) (Prompt: islands)")).toEqual({
      answer: "**Tobago**",
      notes: "Grudgingly accept: **T&T**; Do not prompt; Prompt: islands",
      explanation: null,
    });
    // guidance after ";" is a note, other brackets stay in the answer, explanation is capitalised
    expect(splitAnswer("**Stiletto**(s); Prompt on any reference to Heels; the dagger came first")).toEqual({
      answer: "**Stiletto**(s)",
      notes: "Prompt on any reference to Heels",
      explanation: "The dagger came first",
    });
    expect(splitAnswer("**Selenium**. Named after Selene.")).toEqual({
      answer: "**Selenium**. Named after Selene.",
      notes: null,
      explanation: null,
    });
  });
});

describe("convertRecord", () => {
  it("builds a complete card", () => {
    const out = convertRecord(
      rec({
        qid: 139,
        imageurl: "https://imgur.com/AbCdE12",
        answerText:
          "Lee Harvey **Oswald** (Prompt: JFK's Killer); Jim Leavelle is the detective. <br><img src='https://i.imgur.com/Sib2d04.jpg?1'  height='300px'>",
      }),
    );
    if ("problem" in out) throw new Error(out.problem);
    expect(out.card).toMatchObject({
      id: "zql:S01:GW03:R2:P4:Q1",
      deck: "zql:S01",
      front: "**Which city** is this?",
      back: "Lee Harvey **Oswald**",
      tags: ["S1", "GW03", "R2", "P4", "Q1"],
      category: "History",
      media: [
        { type: "image", url: "https://i.imgur.com/AbCdE12.jpg", side: "front" },
        { type: "image", url: "https://i.imgur.com/Sib2d04.jpg?1", side: "back" },
      ],
      meta: {
        source: "zql",
        qid: 139,
        topic: "Some Topic",
        notes: "Prompt: JFK's Killer",
        explanation: "Jim Leavelle is the detective.",
        info: [
          { label: "Topic", value: "Some Topic" },
          { label: "Source", value: "ZQL S1 · GW03 · Round 2 · Player 4 · Q1" },
          { label: "QID", value: "#139" },
        ],
      },
    });
    expect((out.card.meta as { raw: unknown }).raw).toMatchObject({ qid: 139 });
    expect(out.deck).toEqual({ id: "zql:S01", name: "Season 1", parent: "zql" });
    expect(out.parent).toEqual({ id: "zql", name: "ZQL", kind: "srs", parent: null });
  });

  it("puts video/audio from the question on the front", () => {
    const out = convertRecord(rec({ questionText: 'Listen <audio src="https://audio.jukehost.co.uk/a.mp3"></audio>' }));
    if ("problem" in out) throw new Error(out.problem);
    expect(out.card.front).toBe("Listen");
    expect(out.card.media).toEqual([{ type: "audio", url: "https://audio.jukehost.co.uk/a.mp3", side: "front" }]);
  });
});

describe("convertAll", () => {
  const records = [
    rec({ qid: 3, season: "ZQL S2", gameId: "GW10b" }),
    rec({ qid: 1 }),
    rec({ qid: 2, questionNo: "Question 2" }),
    rec({ qid: 4, season: "CQL S1 (Cultish S0)" }),
    rec({ qid: 5, season: "Cultish S1", roundNo: "Round 8 Player 1", questionNo: "Question 3" }),
    rec({ qid: 6, season: "Mystery League" }),
    rec({ qid: 7 }), // duplicate of qid 1's key
    rec({ qid: 8, gameId: "GW04", questionText: "", imageurl: "" }),
    rec({ qid: 9, gameId: "GW05", imageurl: "https://imgur.com/a/album1" }),
  ];
  const result = convertAll(records);

  it("creates parent decks and season sub-decks for both leagues", () => {
    expect(result.payload.decks).toEqual(
      expect.arrayContaining([
        { id: "zql", name: "ZQL", kind: "srs", parent: null },
        { id: "zql:S01", name: "Season 1", parent: "zql" },
        { id: "zql:S02", name: "Season 2", parent: "zql" },
        { id: "cultish", name: "Cultish", kind: "srs", parent: null },
        { id: "cultish:S00", name: "Season 0 (CQL S1)", parent: "cultish" },
        { id: "cultish:S01", name: "Season 1", parent: "cultish" },
      ]),
    );
  });

  it("orders cards by id and reports problems instead of importing them", () => {
    expect(result.payload.cards.map((c) => c.id)).toEqual([
      "cultish:S00:GW03:R2:P4:Q1",
      "cultish:S01:GW03:R8:P1:Q3",
      "zql:S01:GW03:R2:P4:Q1",
      "zql:S01:GW03:R2:P4:Q2",
      "zql:S01:GW05:R2:P4:Q1",
      "zql:S02:GW10b:R2:P4:Q1",
    ]);
    expect(result.issues).toEqual([
      { qid: 6, problem: 'unrecognised season "Mystery League"' },
      { qid: 7, problem: "duplicate id zql:S01:GW03:R2:P4:Q1" },
      { qid: 8, problem: "zql:S01:GW04:R2:P4:Q1: empty question" },
    ]);
    expect(result.stats.droppedMedia).toEqual([{ id: "zql:S01:GW05:R2:P4:Q1", url: "https://imgur.com/a/album1" }]);
  });

  it("produces a payload the import API accepts", () => {
    expect(() => parseImportPayload(JSON.parse(JSON.stringify(result.payload)))).not.toThrow();
  });
});
