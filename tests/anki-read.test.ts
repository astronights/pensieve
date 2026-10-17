import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildNotes, buildReport, buildSample } from "../scripts/anki/inspect";
import { readAnkiExport } from "../scripts/anki/read";

// Real exports made by Anki itself (tests/fixtures/anki/make_fixtures.py): the current format
// (zstd, schema 18) and the "Support older Anki versions" format (JSON note types).
const fixture = (name: string) => path.join(__dirname, "fixtures", "anki", name);

describe("readAnkiExport", () => {
  it.each(["modern.apkg", "legacy.apkg"])("reads decks, note types, notes and cards from %s", async (file) => {
    const col = await readAnkiExport(fixture(file));
    expect(col.format).toBe(file === "modern.apkg" ? "anki21b" : "anki21");
    expect(col.decks.map((d) => d.name)).toEqual(
      expect.arrayContaining(["Japanese::Vocab::N5", "Japanese::Kanji", "Spanish"]),
    );
    expect(col.notes).toHaveLength(8);
    expect(col.cards).toHaveLength(14);
    expect(col.mediaFiles).toBe(0);

    const vocab = col.noteTypes.find((t) => t.name === "Japanese Vocab")!;
    expect(vocab).toMatchObject({ kind: "standard", fields: ["Word", "Reading", "Meaning", "Example", "Notes"] });
    expect(vocab.templates.map((t) => [t.name, t.front])).toEqual([
      ["Recognition", "{{Word}}"],
      ["Production", "{{Meaning}}"],
    ]);
    expect(col.noteTypes.find((t) => t.name === "Cloze")?.kind).toBe("cloze");

    const cat = col.notes.find((n) => n.fields[0] === "猫")!;
    expect(cat.fields[3]).toBe("猫が<b>好き</b>です。<br>I like cats.");
    expect(cat.tags).toEqual(["animals", "jlpt::n5"]);
  });

  it("rejects files that aren't Anki exports", async () => {
    await expect(readAnkiExport(path.join(__dirname, "..", "public", "icon-192.png"))).rejects.toThrow(/isn't an Anki export/);
    await expect(readAnkiExport(fixture("missing.apkg"))).rejects.toThrow(/File not found/);
  });
});

describe("inspect report", () => {
  it("summarises decks (with empty parents), note types, fields and markup", async () => {
    const report = buildReport(await readAnkiExport(fixture("modern.apkg")));
    // "Default" has no cards, so it is left out; "Japanese" only holds sub-decks.
    expect(report.totals).toEqual({ decks: 5, note_types: 4, notes: 8, cards: 14 });
    expect(report.decks.map((d) => [d.name, d.cards])).toEqual([
      ["Japanese", 0],
      ["Japanese::Kanji", 2],
      ["Japanese::Vocab", 2],
      ["Japanese::Vocab::N5", 4],
      ["Spanish", 6],
    ]);
    const vocab = report.note_types.find((t) => t.name === "Japanese Vocab")!;
    expect(vocab).toMatchObject({ notes: 3, cards: 6 });
    expect(vocab.fields.find((f) => f.name === "Example")).toMatchObject({
      filled: 2,
      features: { html_tag: 1, line_break: 1, bold: 1 },
    });
    expect(report.note_types.find((t) => t.name === "Cloze")!.fields[0].features).toMatchObject({ cloze: 1 });
    expect(report.tags["jlpt::n5"]).toBe(3);
  });

  it("samples whole notes with their cards", async () => {
    const sample = buildSample(await readAnkiExport(fixture("modern.apkg")));
    const reversed = sample.find((s) => s.note_type === "Basic (and reversed card)")!;
    expect(reversed.notes[0]).toMatchObject({
      fields: { Front: "el perro", Back: "the dog" },
      cards: [
        { template: "Card 1", deck: "Spanish" },
        { template: "Card 2", deck: "Spanish" },
      ],
    });
  });
});

describe("inspect notes", () => {
  it("lists every note with its deck, fields and tags", async () => {
    const notes = buildNotes(await readAnkiExport(fixture("modern.apkg")));
    expect(notes).toHaveLength(8);
    expect(notes.find((n) => n.fields.Front === "el perro")).toEqual({
      deck: "Spanish",
      note_type: "Basic (and reversed card)",
      fields: { Front: "el perro", Back: "the dog" },
      tags: ["nouns"],
    });
  });
});
