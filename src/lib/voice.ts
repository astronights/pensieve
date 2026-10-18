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

/** Letters that accents-stripping leaves alone, spelled the way English writes them. */
const FOLD: Record<string, string> = { ø: "o", æ: "ae", œ: "oe", ß: "ss", ł: "l", đ: "d", ð: "d", þ: "th", ı: "i" };

/** The other common way to write umlauts and the like: "Gödel" → "Goedel", "Ångström" → "Aangstroem". */
export function spelledOut(text: string): string {
  return text
    .normalize("NFC")
    .replace(/[äöüåøÄÖÜÅØ]/g, (c) => ({ ä: "ae", ö: "oe", ü: "ue", å: "aa", ø: "oe" })[c.toLowerCase()] ?? c);
}

/** Words of a phrase for comparing: no accents, case, punctuation or "the/a/an/to"; "six" → "6". */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[øæœßłđðþı]/g, (c) => FOLD[c])
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
 * - Bold text in the answer: every bold part must be said ("The **Nile**" → "nile"). An answer
 *   with "or" gives a choice: the bold part(s) of either side ("**Gandhi** OR **Bapu**" takes
 *   either name, not both); a side without bold counts as a whole.
 * - Otherwise any one meaning: lines and parts split by , ; / or "or" ("hoodie, sweatshirt"), with
 *   or without a part in brackets ("to eat (verb)").
 * - Plus anything after "Accept:" in the notes.
 */
export function answerTargets(back: string, notes?: string | null): string[][] {
  const out: string[][] = [];
  const add = (phrases: string[]) => {
    // Each answer as written with accents dropped ("Godel") and with them spelled out ("Goedel").
    for (const spell of [(p: string) => p, spelledOut]) {
      const clean = phrases.map((p) => words(spell(p)).join(" ")).filter(Boolean);
      if (clean.length === phrases.length && clean.length > 0 && !out.some((o) => o.join("|") === clean.join("|")))
        out.push(clean);
    }
  };
  const BOLD = /\*\*(.+?)\*\*|__(.+?)__/g;
  const OR = /\s+or\s+/i;
  const boldOf = (text: string) => [...text.matchAll(BOLD)].map((m) => plainText(m[1] ?? m[2]));
  if (boldOf(back).length > 0) {
    // "**A or B**" is the same choice as "**A** or **B**".
    const sides = back
      .replace(BOLD, (_, a: string | undefined, b: string | undefined) =>
        (a ?? b ?? "")
          .split(OR)
          .map((x) => `**${x}**`)
          .join(" or "),
      )
      .split(OR);
    for (const side of sides) {
      const bold = boldOf(side);
      add(bold.length > 0 ? bold : [plainText(side)]);
    }
  } else {
    for (const part of plainText(back).split(/[\n,;/]|\s+or\s+/i)) {
      add([part]);
      const unbracketed = part.replace(/\([^)]*\)|\[[^\]]*\]/g, " ");
      if (unbracketed !== part) add([unbracketed]);
    }
  }
  for (const m of (notes ?? "").matchAll(/accept:\s*([^\n]+)/gi)) {
    for (const alt of plainText(m[1]).split(/[,;/]|\bor\b/i)) add([alt]);
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

/**
 * Spelling slack for a phrase of this many letters (speech recognition spells names loosely). Short
 * words must match exactly so near neighbours stay wrong: Iran/Iraq, Austria/Australia, Slovakia/Slovenia.
 */
const slack = (len: number) => (len <= 4 ? 0 : len <= 9 ? 1 : len <= 12 ? 2 : Math.floor(len / 5));

/**
 * Roughly how a word sounds, so a name the recogniser spelled the English way still matches:
 * "Philippe" ≈ "filip", "Schumann" ≈ "shuman", "Tchaikovsky" ≈ "chaikovski". Rules on letters only.
 */
export function sound(word: string): string {
  return word
    .replace(/ph/g, "f")
    .replace(/t?sch|tch|tsh/g, (m) => (m.startsWith("t") ? "ch" : "sh"))
    .replace(/gh|th|dt/g, (m) => (m[0] === "g" ? "g" : "t"))
    .replace(/ck|q/g, "k")
    .replace(/x/g, "ks")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/c(?!h)/g, "k")
    .replace(/z/g, "s")
    .replace(/w/g, "v")
    .replace(/ee|ie|ea/g, "i")
    .replace(/oo|ou|ue/g, "u")
    .replace(/ae/g, "e")
    .replace(/oe/g, "o")
    .replace(/y/g, "i")
    .replace(/(.)\1+/g, "$1")
    .replace(/(?<=..)e$/, "");
}

/** True if `phrase` (already normalised) was said somewhere in `heard`, allowing small misspellings. */
function said(heard: string[], phrase: string): boolean {
  const target = phrase.replace(/ /g, "");
  const targetSound = sound(target);
  const n = phrase.split(" ").length;
  for (let i = 0; i < heard.length; i++) {
    // Compare against runs of nearby length, so "ulan bator" can match "ulaanbaatar".
    for (let w = Math.max(1, n - 1); w <= n + 1 && i + w <= heard.length; w++) {
      const run = heard.slice(i, i + w).join("");
      if (levenshtein(run, target) <= slack(target.length)) return true;
      if (levenshtein(sound(run), targetSound) <= slack(targetSound.length)) return true;
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
/** Hesitations a verbatim transcript keeps ("um, show"). */
const FILLERS = new Set(["um", "umm", "uh", "uhm", "er", "erm", "hmm", "ah", "oh", "okay", "ok", "so"]);

export function parseCommand(text: string, phase: VoicePhase): VoiceCommand | null {
  const w = text
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, " ")
    .split(/\s+/)
    .filter((x) => x && !FILLERS.has(x));
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

/**
 * What the user said, without the words the app was reading aloud at the time (the mic hears those
 * too). "" if nothing of the user's own is left.
 */
export function stripEcho(heard: string, spoken: Set<string>): string {
  if (spoken.size === 0) return heard.trim();
  const kept = heard.split(/\s+/).filter((token) => {
    const w = words(token);
    return w.length > 0 && !w.every((x) => spoken.has(x));
  });
  return kept.join(" ");
}
