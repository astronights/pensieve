/**
 * Voice study helpers (pure, no browser APIs): checking a spoken answer against a card, reading
 * commands, and choosing what to read aloud in which language.
 */

const STOPWORDS = new Set(["the", "a", "an", "to"]);

const NUMBER_WORDS: Record<string, string> = {
  zero: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
  eleven: "11",
  twelve: "12",
  thirteen: "13",
  fourteen: "14",
  fifteen: "15",
  sixteen: "16",
  seventeen: "17",
  eighteen: "18",
  nineteen: "19",
  twenty: "20",
  thirty: "30",
  forty: "40",
  fifty: "50",
  sixty: "60",
  seventy: "70",
  eighty: "80",
  ninety: "90",
  hundred: "100",
};

/** Words of a phrase for comparing: no accents, case, punctuation or "the/a/an/to"; "six" → "6". */
export function words(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((w) => w && !STOPWORDS.has(w))
    .map((w) => NUMBER_WORDS[w] ?? w);
}

/** Markdown → plain text: drops escapes, emphasis markers, link targets and list/heading markers. */
export function plainText(md: string): string {
  // Escaped characters are literal: park them in the Private Use Area while markers are removed.
  const parked: string[] = [];
  return md
    .replace(/\\([\\`*_[\]<>|#+\-.!()])/g, (_, c: string) => String.fromCharCode(0xe000 + parked.push(c) - 1))
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|\*|_|`)/g, "")
    .replace(/^\s*(#+|>|[-+]|\d+[.)])\s+/gm, "")
    .replace(/[\ue000-\uf8ff]/g, (c) => parked[c.charCodeAt(0) - 0xe000] ?? "")
    .trim();
}

/**
 * What counts as a right answer. Each alternative is a list of phrases that must all be said.
 * - Bold text in the answer: every bold part must be said ("The **Nile**" → "nile").
 * - Otherwise any one meaning: lines and parts split by , ; / ("hoodie, sweatshirt"), with or
 *   without a part in brackets ("to eat (verb)").
 * - Plus anything after "Accept:" in the notes.
 */
export function answerTargets(back: string, notes?: string | null): string[][] {
  const out: string[][] = [];
  const add = (phrases: string[]) => {
    const clean = phrases.map((p) => words(p).join(" ")).filter(Boolean);
    if (clean.length === phrases.length && clean.length > 0) out.push(clean);
  };
  const bold = [...back.matchAll(/\*\*(.+?)\*\*|__(.+?)__/g)].map((m) => plainText(m[1] ?? m[2]));
  if (bold.length > 0) {
    add(bold);
  } else {
    for (const part of plainText(back).split(/[\n,;/]/)) {
      add([part]);
      const unbracketed = part.replace(/\([^)]*\)|\[[^\]]*\]/g, " ");
      if (unbracketed !== part) add([unbracketed]);
    }
  }
  for (const m of (notes ?? "").matchAll(/accept:\s*([^\n]+)/gi)) {
    for (const alt of plainText(m[1]).split(/[,;/]|\bor\b/)) add([alt]);
  }
  return out;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Spelling slack for a phrase of this many letters (speech recognition spells names loosely). */
const slack = (len: number) => (len <= 3 ? 0 : len <= 5 ? 1 : len <= 8 ? 2 : Math.floor(len / 3));

/** True if `phrase` (already normalised) was said somewhere in `heard`, allowing small misspellings. */
function said(heard: string[], phrase: string): boolean {
  const target = phrase.replace(/ /g, "");
  const n = phrase.split(" ").length;
  for (let i = 0; i < heard.length; i++) {
    // Compare against runs of nearby length, so "ulan bator" can match "ulaanbaatar".
    for (let w = Math.max(1, n - 1); w <= n + 1 && i + w <= heard.length; w++) {
      if (levenshtein(heard.slice(i, i + w).join(""), target) <= slack(target.length)) return true;
    }
  }
  return false;
}

/** Whether any of the recogniser's guesses contains a right answer. */
export function checkAnswer(heard: string[], targets: string[][]): boolean {
  return heard.some((h) => {
    const w = words(h);
    return targets.some((alt) => alt.every((p) => said(w, p)));
  });
}

export type VoicePhase = "question" | "answer" | "verdict";
export type VoiceCommand = "show" | "repeat" | "more" | "stop" | "good" | "again";

const COMMANDS: Record<VoicePhase, Record<string, VoiceCommand>> = {
  // Before the reveal anything else is an answer, so "yes"/"no" stay usable as answers.
  question: {
    show: "show",
    answer: "show",
    reveal: "show",
    pass: "show",
    repeat: "repeat",
    stop: "stop",
  },
  answer: {
    good: "good",
    yes: "good",
    right: "good",
    correct: "good",
    next: "good",
    again: "again",
    no: "again",
    wrong: "again",
    repeat: "repeat",
    more: "more",
    stop: "stop",
  },
  // While the 2-second verdict is showing: confirm or flip it.
  verdict: {
    right: "good",
    correct: "good",
    good: "good",
    yes: "good",
    wrong: "again",
    again: "again",
    no: "again",
    repeat: "repeat",
    more: "more",
    stop: "stop",
  },
};

/** A short utterance that is a command in this phase, else null (before the reveal: an answer). */
export function parseCommand(text: string, phase: VoicePhase): VoiceCommand | null {
  const w = text
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (w.length === 0 || w.length > 3) return null;
  // Before the reveal only the first word counts ("show answer"), so an answer like "TV show" is
  // still an answer; after it, the first command word anywhere wins ("that's right").
  for (const word of phase === "question" ? w.slice(0, 1) : w) {
    const cmd = COMMANDS[phase][word];
    if (cmd) return cmd;
  }
  return null;
}

/** Spoken languages by common name, for a deck named after its language. */
const LANGUAGES: Record<string, string> = {
  english: "en-US",
  swedish: "sv-SE",
  russian: "ru-RU",
  mandarin: "zh-CN",
  chinese: "zh-CN",
  cantonese: "zh-HK",
  japanese: "ja-JP",
  korean: "ko-KR",
  french: "fr-FR",
  spanish: "es-ES",
  german: "de-DE",
  italian: "it-IT",
  portuguese: "pt-PT",
  dutch: "nl-NL",
  norwegian: "nb-NO",
  danish: "da-DK",
  finnish: "fi-FI",
  polish: "pl-PL",
  greek: "el-GR",
  turkish: "tr-TR",
  arabic: "ar-SA",
  hebrew: "he-IL",
  hindi: "hi-IN",
  thai: "th-TH",
  vietnamese: "vi-VN",
  indonesian: "id-ID",
  ukrainian: "uk-UA",
  czech: "cs-CZ",
};

export const SPOKEN_LANGUAGES = Object.entries(LANGUAGES)
  .filter(([name]) => name !== "chinese")
  .map(([name, code]) => ({
    code,
    name: name[0].toUpperCase() + name.slice(1),
  }));

/** "Swedish" or "Swedish (demo)" → "sv-SE"; null if the deck isn't named after a language. */
export function languageFromName(name: string): string | null {
  for (const w of words(name)) if (LANGUAGES[w]) return LANGUAGES[w];
  return null;
}

const SCRIPTS: [RegExp, string][] = [
  [/\p{Script=Cyrillic}/u, "ru-RU"],
  [/[\p{Script=Hiragana}\p{Script=Katakana}]/u, "ja-JP"],
  [/\p{Script=Han}/u, "zh-CN"],
  [/\p{Script=Hangul}/u, "ko-KR"],
  [/\p{Script=Greek}/u, "el-GR"],
  [/\p{Script=Arabic}/u, "ar-SA"],
  [/\p{Script=Hebrew}/u, "he-IL"],
  [/\p{Script=Devanagari}/u, "hi-IN"],
  [/\p{Script=Thai}/u, "th-TH"],
];

/** The language a non-Latin line is written in, or null for Latin script (it could be any). */
export function languageOfScript(text: string): string | null {
  for (const [re, lang] of SCRIPTS) if (re.test(text)) return lang;
  return null;
}

/** Pinyin tone marks (ā ǎ …): a line of pinyin sounds wrong read by any voice, so it's skipped. */
const PINYIN = /[āēīōūǖǎěǐǒǔǚǘǜ]/;

export type SpeechPart = { text: string; lang: string };

/**
 * What to read aloud for a card side: each line in its own language. Non-Latin lines are read in
 * the language of their script; Latin lines in `latinLang` (the deck's language on the front,
 * English on the back). Pinyin lines are skipped.
 */
export function speechParts(md: string, latinLang: string): SpeechPart[] {
  return plainText(md)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !PINYIN.test(l))
    .map((text) => ({ text, lang: languageOfScript(text) ?? latinLang }));
}
