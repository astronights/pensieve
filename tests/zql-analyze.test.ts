import { describe, expect, it } from "vitest";
import { analyze, pickSample, type RawQuestion } from "../scripts/zql/analyze";

const q = (over: Partial<RawQuestion>): RawQuestion => ({
  season: "S1",
  gameId: "G1",
  roundNo: 1,
  questionNo: 1,
  number: 1,
  category: "Sports",
  quad: "A",
  questionText: "Who won?",
  answerText: "Someone",
  imageurl: "",
  ...over,
});

const records = [
  q({}),
  q({ questionNo: 2, questionText: "**Bold** _it_ <br> line\nnext", imageurl: "https://i.imgur.com/x.png" }),
  q({ questionNo: 3, answerText: 'Look <img src="https://drive.google.com/uc?id=1"> &amp; see' }),
  q({ season: "S2", questionText: '<video src="https://cdn.example.com/v.mp4"></video> [link](https://youtu.be/abc)' }),
  q({ season: "S2", gameId: "G2", quad: "B", answerText: "", extra: 42 }),
  q({ season: "S2", gameId: "G2", quad: "B", answerText: "dup" }), // same natural key as previous
];

describe("analyze", () => {
  const report = analyze(records);

  it("describes every field, including unexpected ones", () => {
    expect(report.total_records).toBe(6);
    expect(Object.keys(report.fields)).toContain("extra");
    expect(report.fields.season).toMatchObject({ filled: 6, value_counts: { S2: 3, S1: 3 } });
    expect(report.fields.imageurl).toMatchObject({ present: 6, filled: 1 });
    expect(report.fields.roundNo).toMatchObject({ types: { number: 6 } });
  });

  it("summarises markup, media and hosts in the text fields", () => {
    const qt = report.text.questionText as Record<string, Record<string, number>>;
    expect(qt.records_with_feature).toMatchObject({ bold: 1, newline: 1, html_tag: 2, youtube: 1, markdown_link: 1 });
    expect(qt.html_tag_occurrences).toMatchObject({ br: 1, video: 1 });
    expect(qt.url_hosts).toMatchObject({ "cdn.example.com": 1, "youtu.be": 1 });
    const at = report.text.answerText as Record<string, Record<string, number>>;
    expect(at.records_with_feature).toMatchObject({ html_entity: 1, google_drive: 1 });
    expect(report.imageurl.hosts).toEqual({ "i.imgur.com": 1 });
  });

  it("flags duplicate natural keys", () => {
    expect(report.natural_key.duplicates).toBe(1);
    expect(report.natural_key.duplicate_examples).toEqual(["S2 | G2 | 1 | 1"]);
  });
});

describe("pickSample", () => {
  it("covers seasons, quads, media and edge cases with full records and reasons", () => {
    const sample = pickSample(records);
    const reasons = sample.flatMap((r) => r._sample_reasons as string[]);
    expect(reasons).toEqual(
      expect.arrayContaining([
        "season S1",
        "season S2",
        "quad B",
        "has imageurl",
        "media in answer text",
        "video",
        "youtube",
        "google drive",
        "bold/italic",
        "empty answer text",
        "<br> tag",
      ]),
    );
    // Full, untruncated records.
    expect(sample.find((r) => r.questionNo === 3)).toMatchObject({ answerText: records[2].answerText });
  });

  it("respects the cap", () => {
    const many = Array.from({ length: 500 }, (_, i) => q({ season: `S${i}` }));
    expect(pickSample(many, 3, 25)).toHaveLength(25);
  });
});
