import { describe, expect, it } from "vitest";
import {
  answerTargets,
  checkAnswer,
  languageFromName,
  languageOfScript,
  parseCommand,
  plainText,
  speechParts,
  stripEcho,
  words,
} from "@/lib/voice";

const right = (said: string | string[], back: string, notes?: string) =>
  checkAnswer(Array.isArray(said) ? said : [said], answerTargets(back, notes));

describe("answer checking", () => {
  it("needs the bold part when the answer has one", () => {
    expect(right("the nile", "The **Nile**")).toBe(true);
    expect(right("I think it's the Nile river", "The **Nile**")).toBe(true);
    expect(right("the amazon", "The **Nile**")).toBe(false);
    expect(right("romeo", "**Romeo** and **Juliet**")).toBe(false);
    expect(right("romeo and juliet", "**Romeo** and **Juliet**")).toBe(true);
  });

  it("with OR, takes the bold part of either side on its own", () => {
    const back = "**Mahatma Gandhi** OR **Bapu**";
    expect(right("gandhi", back)).toBe(false);
    expect(right("mahatma gandhi", back)).toBe(true);
    expect(right("bapu", back)).toBe(true);
    expect(answerTargets(back)).toEqual([["mahatma gandhi"], ["bapu"]]);
    expect(right("amazon", "The **Nile** or the **Amazon**")).toBe(true);
    expect(right("nile", "**Nile or Amazon**")).toBe(true);
    // Both bold parts on one side are still both needed.
    expect(right("romeo", "**Romeo** and **Juliet** or **Tristan** and **Isolde**")).toBe(false);
    expect(right("tristan and isolde", "**Romeo** and **Juliet** or **Tristan** and **Isolde**")).toBe(true);
    // A side without bold counts as a whole.
    expect(right("trinidad and tobago", "**Tobago** or Trinidad and Tobago")).toBe(true);
    // A slash is a choice too, but not in a number.
    expect(right("mumbai", "**Bombay** / **Mumbai**")).toBe(true);
    expect(right("bombay", "**Bombay/Mumbai**")).toBe(true);
    expect(right("bombay mumbai", "**Bombay**/**Mumbai**")).toBe(true);
    expect(right("1", "**1/2**")).toBe(false);
    expect(right("1/2", "**1/2**")).toBe(true);
    // Without bold, "or" separates meanings too.
    expect(right("automobile", "car or automobile")).toBe(true);
  });

  it("takes any one meaning when nothing is bold", () => {
    expect(right("sweatshirt", "hoodie, sweatshirt")).toBe(true);
    expect(right("hoodie", "Hoodie; sweatshirt")).toBe(true);
    expect(right("jacket", "hoodie, sweatshirt")).toBe(false);
    expect(right("eat", "to eat (verb)")).toBe(true);
    expect(right("baseball cap", "baseball cap")).toBe(true);
    // A pinyin line doesn't get in the way of the meaning on the next line.
    expect(right("to buy", "mǎi\nto buy")).toBe(true);
  });

  it("ignores case, accents, punctuation and small misspellings", () => {
    expect(right("Ulan Bator", "Ulaanbaatar")).toBe(true);
    expect(right("cafe", "Café!")).toBe(true);
    expect(right("leonardo da vinci", "Leonardo da Vinci")).toBe(true);
    expect(right("leonardo de vinci", "Leonardo da Vinci")).toBe(true);
    // Short words must match exactly, so "cat" isn't "car".
    expect(right("car", "cat")).toBe(false);
  });

  it("accepts foreign letters written the English way", () => {
    expect(right("godel", "Gödel")).toBe(true);
    expect(right("goedel", "Gödel")).toBe(true);
    expect(right("strauss", "Strauß")).toBe(true);
    expect(right("malmo", "Malmø")).toBe(true);
    expect(right("angstrom", "Ångström")).toBe(true);
    expect(right("zurich", "Zürich")).toBe(true);
    expect(right("aero", "Ærø")).toBe(true);
  });

  it("accepts names that sound the same but are spelled the English way", () => {
    expect(right("filip", "Philippe")).toBe(true);
    expect(right("shuman", "Schumann")).toBe(true);
    expect(right("chaikovski", "Tchaikovsky")).toBe(true);
    expect(right("ulan bator", "Ulaanbaatar")).toBe(true);
  });

  it("keeps near neighbours wrong", () => {
    expect(right("iraq", "Iran")).toBe(false);
    expect(right("australia", "Austria")).toBe(false);
    expect(right("sudan", "Sweden")).toBe(false);
    expect(right("peru", "Paris")).toBe(false);
    expect(right("mali", "Malawi")).toBe(false);
    expect(right("niger", "Nigeria")).toBe(false);
    expect(right("slovenia", "Slovakia")).toBe(false);
  });

  it("reads numbers said as words", () => {
    expect(right("six", "Six")).toBe(true);
    expect(right("6", "six")).toBe(true);
    expect(right("206", "206")).toBe(true);
  });

  it("accepts the alternatives in the notes", () => {
    expect(right("trinidad and tobago", "**Tobago**", "Grudgingly accept: Trinidad and Tobago")).toBe(true);
    expect(right("swahili", "Kiswahili", "Accept: Swahili")).toBe(true);
    expect(right("burma", "Myanmar", "Prompt: Burma")).toBe(false);
  });

  it("checks every guess the recogniser offers", () => {
    expect(right(["the vile", "the nile"], "The **Nile**")).toBe(true);
  });

  it("ignores markdown escapes from imported text", () => {
    expect(plainText("a \\* b \\_c\\_")).toBe("a * b _c_");
    expect(answerTargets("\\- hello")).toEqual([["hello"]]);
  });

  it("never counts an empty answer as right", () => {
    expect(right("the", "The")).toBe(false);
    expect(right("", "hello")).toBe(false);
  });
});

describe("commands", () => {
  it("before the reveal only show/repeat/stop are commands; the rest is an answer", () => {
    expect(parseCommand("show", "question")).toBe("show");
    expect(parseCommand("Show answer", "question")).toBe("show");
    expect(parseCommand("repeat", "question")).toBe("repeat");
    expect(parseCommand("stop", "question")).toBe("stop");
    expect(parseCommand("yes", "question")).toBeNull();
    expect(parseCommand("no", "question")).toBeNull();
    expect(parseCommand("TV show", "question")).toBeNull();
  });

  it("after the reveal: good/again and their synonyms", () => {
    expect(parseCommand("good", "answer")).toBe("good");
    expect(parseCommand("yes", "answer")).toBe("good");
    expect(parseCommand("again", "answer")).toBe("again");
    expect(parseCommand("no", "answer")).toBe("again");
    expect(parseCommand("more", "answer")).toBe("more");
    expect(parseCommand("the cat sat on the mat", "answer")).toBeNull();
  });

  it("understands commands the way recognisers and accents spell them", () => {
    for (const said of ["so", "Shoe.", "shaw", "show me", "please show", "I don't know", "no idea", "pass"])
      expect(parseCommand(said, "question"), said).toBe("show");
    for (const said of ["write", "Ride.", "that's right", "you're right", "yeah", "correct", "righ"])
      expect(parseCommand(said, "verdict"), said).toBe("good");
    for (const said of ["wrong", "rong", "that's wrong", "nope", "not right", "wromg"])
      expect(parseCommand(said, "verdict"), said).toBe("again");
    expect(parseCommand("not wrong", "verdict")).toBe("good");
    // Near-misses never stop voice, and an answer that isn't a command stays an answer.
    expect(parseCommand("step", "answer")).toBeNull();
    expect(parseCommand("snowman", "question")).toBeNull();
  });

  it("ignores hesitations", () => {
    expect(parseCommand("Um, show.", "question")).toBe("show");
    expect(parseCommand("uh good", "answer")).toBe("good");
  });

  it("while a verdict shows: right/wrong flip it", () => {
    expect(parseCommand("that's right", "verdict")).toBe("good");
    expect(parseCommand("wrong", "verdict")).toBe("again");
  });
});

describe("echo", () => {
  it("drops the words being read aloud and keeps the user's", () => {
    const spoken = new Set(words("hello, hi"));
    expect(stripEcho("hello hi good", spoken)).toBe("good");
    expect(stripEcho("Hello, hi.", spoken)).toBe("");
    expect(stripEcho("the nile", new Set())).toBe("the nile");
  });
});

describe("reading aloud", () => {
  it("finds a deck's language from its name or a line's script", () => {
    expect(languageFromName("Swedish")).toBe("sv-SE");
    expect(languageFromName("Spanish (demo)")).toBe("es-ES");
    expect(languageFromName("Geography")).toBeNull();
    expect(languageOfScript("бейсбо́лка")).toBe("ru-RU");
    expect(languageOfScript("买")).toBe("zh-CN");
    expect(languageOfScript("hej")).toBeNull();
  });

  it("reads each line in its language and skips pinyin", () => {
    expect(speechParts("买", "en-US")).toEqual([{ text: "买", lang: "zh-CN" }]);
    expect(speechParts("mǎi\nto buy", "en-US")).toEqual([{ text: "to buy", lang: "en-US" }]);
    expect(speechParts("hej då", "sv-SE")).toEqual([{ text: "hej då", lang: "sv-SE" }]);
    expect(speechParts("The **Nile**", "en-US")).toEqual([{ text: "The Nile", lang: "en-US" }]);
  });

  it("normalises words for comparing", () => {
    expect(words("The Ñandú, to-day!")).toEqual(["nandu", "day"]);
  });
});
