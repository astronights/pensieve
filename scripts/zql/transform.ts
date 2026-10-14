/**
 * Turns raw ZQL question-bank records into Pensieve import payloads. Pure functions, no I/O.
 *
 * Text fields are Markdown with some inline HTML. We keep the formatting (converting the HTML to
 * Markdown), move every image/video/audio into the card's media list, and split the answer into
 * the answer itself, marking notes ("Accept: …") and an explanation.
 */
import type { ImportCard, ImportDeck, ImportPayload } from "../../src/lib/import";
import type { MediaItem } from "../../src/db/schema";

export type RawQuestion = Record<string, unknown>;

type League = { id: string; name: string };
const LEAGUES: Record<string, League> = {
  zql: { id: "zql", name: "ZQL" },
  cultish: { id: "cultish", name: "Cultish" },
};

export type ParsedSeason = { league: League; season: number; label: string; deckName: string };

/** "ZQL S3" → zql/3; "Cultish S1" → cultish/1; "CQL S1 (Cultish S0)" → cultish/0. */
export function parseSeason(value: unknown): ParsedSeason | null {
  const s = String(value ?? "").trim();
  let m = s.match(/^ZQL S(\d+)$/i);
  if (m) return season(LEAGUES.zql, Number(m[1]), s);
  m = s.match(/\(Cultish S(\d+)\)$/i) ?? s.match(/^Cultish S(\d+)$/i);
  if (m) {
    const n = Number(m[1]);
    return { ...season(LEAGUES.cultish, n, s), deckName: s.startsWith("CQL") ? `Season ${n} (CQL S1)` : `Season ${n}` };
  }
  return null;
}

function season(league: League, n: number, label: string): ParsedSeason {
  return { league, season: n, label, deckName: `Season ${n}` };
}

/** "GW08a" → { game: 8, suffix: "a", code: "GW08a" } */
export function parseGame(value: unknown) {
  const m = String(value ?? "").trim().match(/^GW(\d+)([a-z]?)$/i);
  if (!m) return null;
  const game = Number(m[1]);
  const suffix = m[2].toLowerCase();
  return { game, suffix, code: `GW${String(game).padStart(2, "0")}${suffix}` };
}

/** "Round 3 Player 2" → { round: 3, player: 2 } */
export function parseRound(value: unknown) {
  const m = String(value ?? "").trim().match(/^Round (\d+) Player (\d+)$/i);
  return m ? { round: Number(m[1]), player: Number(m[2]) } : null;
}

/** "Question 2" → 2 */
export function parseQuestionNo(value: unknown) {
  const m = String(value ?? "").trim().match(/^Question (\d+)$/i);
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------- media --

/**
 * Normalises a media URL: imgur page links become direct links, .gifv becomes .mp4.
 * Returns null for things that can't be shown inline (albums, galleries, non-http).
 */
export function normaliseMediaUrl(raw: string): { url: string; type?: MediaItem["type"] } | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.protocol = "https:";
  if (url.hostname === "imgur.com" || url.hostname === "www.imgur.com") {
    const id = url.pathname.match(/^\/([A-Za-z0-9]{5,8})(\.[a-z0-9]+)?$/)?.[1];
    if (!id) return null; // /a/… albums and /gallery/… can't be embedded
    url = new URL(`https://i.imgur.com/${id}.jpg`);
  }
  if (url.hostname === "i.imgur.com" && url.pathname.endsWith(".gifv")) {
    url.pathname = url.pathname.replace(/\.gifv$/, ".mp4");
    return { url: url.toString(), type: "video" };
  }
  return { url: url.toString() };
}

const VIDEO_EXT = /\.(mp4|webm|mov|m4v)(\?|$)/i;
const AUDIO_EXT = /\.(mp3|wav|ogg|m4a|aac|flac)(\?|$)/i;

export function guessType(url: string): MediaItem["type"] {
  if (VIDEO_EXT.test(url)) return "video";
  if (AUDIO_EXT.test(url)) return "audio";
  return "image";
}

type Extracted = { text: string; media: { type: MediaItem["type"]; url: string }[]; dropped: string[] };

const attr = (tag: string, name: string) =>
  tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"))?.slice(1).find(Boolean);

/** Pulls <img>/<video>/<audio>/<source> and Markdown images out of text, in order of appearance. */
export function extractMedia(input: string): Extracted {
  const media: Extracted["media"] = [];
  const dropped: string[] = [];
  const add = (type: MediaItem["type"], src: string | undefined) => {
    if (!src) return;
    const n = normaliseMediaUrl(src);
    if (!n) return void dropped.push(src);
    if (!media.some((m) => m.url === n.url)) media.push({ type: n.type ?? type, url: n.url });
  };

  const text = input
    // <video …>…</video> and <audio …>…</audio>, with src on the tag or on <source> children
    .replace(/<(video|audio)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi, (_, kind: string, attrs: string, inner: string) => {
      const type = kind.toLowerCase() as MediaItem["type"];
      add(type, attr(attrs, "src"));
      for (const s of inner.matchAll(/<source\b[^>]*>/gi)) add(type, attr(s[0], "src"));
      return " ";
    })
    // self-closing or unclosed media tags
    .replace(/<(video|audio)\b[^>]*\/?>/gi, (tag: string, kind: string) => {
      add(kind.toLowerCase() as MediaItem["type"], attr(tag, "src"));
      return " ";
    })
    .replace(/<img\b[^>]*>/gi, (tag: string) => {
      const src = attr(tag, "src");
      add(src ? guessType(src) : "image", src);
      return " ";
    })
    .replace(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_, src: string) => {
      add(guessType(src), src);
      return " ";
    });
  return { text, media, dropped };
}

// ----------------------------------------------------------------- text --

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Converts the inline HTML that appears in ZQL text to Markdown and tidies whitespace. */
export function htmlToMarkdown(input: string): string {
  return (
    input
      .replace(/\r\n?/g, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<hr\s*\/?>/gi, "\n\n---\n\n")
      .replace(/<\/?(strong|b)>/gi, "**")
      .replace(/<\/?(em|i)>/gi, "*")
      .replace(/<\/?[a-z][^>]*>/gi, "") // any other tag (span, div, p…): keep its text
      .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
        if (e[0] === "#") {
          const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
          return Number.isFinite(code) ? String.fromCodePoint(code) : m;
        }
        return ENTITIES[e.toLowerCase()] ?? m;
      })
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .split("\n")
      .map(fixBoldSpacing)
      .join("\n")
      .trim()
  );
}

/**
 * Markdown ignores `**` next to a space on the inside ("**Velodrome **(…"), leaving literal
 * asterisks. Pair up the markers on a line and move such spaces outside each pair.
 * Lines with an odd number of markers are left alone.
 */
export function fixBoldSpacing(line: string): string {
  const parts = line.split("**");
  if (parts.length < 3 || parts.length % 2 === 0) return line;
  let out = parts[0];
  for (let i = 1; i < parts.length; i += 2) {
    const inner = parts[i];
    const lead = inner.match(/^\s*/)![0];
    const trail = inner.match(/\s*$/)![0];
    const core = inner.trim();
    const after = parts[i + 1];
    out += core ? `${lead}**${core}**${trail && !/^\s/.test(after) ? " " : ""}` : inner;
    out += after;
  }
  return out;
}

const NOTE_START = /^\s*(?:\*\*)?\s*(also\s+accept|accept|grudg?ingly|grudingly|prompt|do\s+not|don'?t|dont|reject|no\s+prompt|not\s+accept)/i;

/** Splits on `sep` only where it isn't inside (…) brackets. */
function splitTopLevel(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === sep && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}

const capitalise = (s: string) => s.replace(/^([*_\s"“‘']*)(\p{Ll})/u, (_, pre: string, c: string) => pre + c.toUpperCase());

export type SplitAnswer = { answer: string; notes: string | null; explanation: string | null };

/**
 * "**Tobago** (Grudgingly accept: **T&T**; Do not prompt) more; It was…" →
 *   answer "**Tobago** more", notes "Grudgingly accept: **T&T**; Do not prompt", explanation "It was…"
 * Rules: marking-guidance brackets anywhere become notes; the first top-level ";" separates the
 * answer from the explanation; explanation segments that are marking guidance also become notes.
 */
export function splitAnswer(markdown: string): SplitAnswer {
  const notes: string[] = [];
  const [first, ...rest] = splitTopLevel(markdown, ";");

  const answer = first
    .replace(/\(([^()]*)\)/g, (whole, inner: string) => (NOTE_START.test(inner) ? (notes.push(inner.trim()), " ") : whole))
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();

  const explanation: string[] = [];
  for (const segment of rest.map((s) => s.trim()).filter(Boolean)) {
    if (NOTE_START.test(segment)) notes.push(segment.replace(/^\(([\s\S]*)\)$/, "$1").trim());
    else explanation.push(segment);
  }
  return {
    answer: answer || markdown.trim(),
    notes: notes.length ? notes.join("; ") : null,
    explanation: explanation.length ? capitalise(explanation.join("; ")) : null,
  };
}

// ---------------------------------------------------------------- cards --

export type Issue = { qid: unknown; problem: string };

export type ConvertResult = {
  payload: ImportPayload;
  issues: Issue[];
  stats: {
    records: number;
    cards: number;
    byDeck: Record<string, number>;
    media: Record<string, number>;
    unsplitLongAnswers: { id: string; answer: string }[];
    droppedMedia: { id: string; url: string }[];
  };
};

const text = (v: unknown) => (typeof v === "string" ? v : "");

export function convertRecord(r: RawQuestion): { card: ImportCard; deck: ImportDeck; parent: ImportDeck; dropped: string[] } | { problem: string } {
  const season = parseSeason(r.season);
  const game = parseGame(r.gameId);
  const round = parseRound(r.roundNo);
  const question = parseQuestionNo(r.questionNo);
  if (!season) return { problem: `unrecognised season "${String(r.season)}"` };
  if (!game) return { problem: `unrecognised gameId "${String(r.gameId)}"` };
  if (!round) return { problem: `unrecognised roundNo "${String(r.roundNo)}"` };
  if (!question) return { problem: `unrecognised questionNo "${String(r.questionNo)}"` };

  const seasonCode = `S${String(season.season).padStart(2, "0")}`;
  const deckId = `${season.league.id}:${seasonCode}`;
  const id = `${deckId}:${game.code}:R${round.round}:P${round.player}:Q${question}`;

  const media: MediaItem[] = [];
  const dropped: string[] = [];
  const imageUrl = text(r.imageurl).trim();
  if (imageUrl) {
    const n = normaliseMediaUrl(imageUrl);
    if (n) media.push({ type: n.type ?? guessType(n.url), url: n.url, side: "front" });
    else dropped.push(imageUrl);
  }
  const q = extractMedia(text(r.questionText));
  const a = extractMedia(text(r.answerText));
  for (const m of q.media) if (!media.some((x) => x.url === m.url)) media.push({ ...m, side: "front" });
  for (const m of a.media) if (!media.some((x) => x.url === m.url && x.side === "back")) media.push({ ...m, side: "back" });
  dropped.push(...q.dropped, ...a.dropped);

  const front = htmlToMarkdown(q.text);
  const split = splitAnswer(htmlToMarkdown(a.text));
  const topic = text(r.quad).trim();
  const category = text(r.category).trim() || null;
  const qid = typeof r.qid === "number" ? r.qid : Number(r.qid) || null;

  const info = [
    topic && { label: "Topic", value: topic },
    { label: "Source", value: `${season.label} · ${game.code} · Round ${round.round} · Player ${round.player} · Q${question}` },
    qid !== null && { label: "QID", value: `#${qid}` },
  ].filter(Boolean);

  return {
    card: {
      id,
      deck: deckId,
      front,
      back: split.answer,
      tags: [`S${season.season}`, game.code, `R${round.round}`, `P${round.player}`, `Q${question}`],
      category,
      media,
      meta: {
        source: season.league.id,
        qid,
        topic: topic || null,
        season: season.season,
        game: game.code,
        round: round.round,
        player: round.player,
        question,
        notes: split.notes,
        explanation: split.explanation,
        info,
        raw: r,
      },
    },
    deck: { id: deckId, name: season.deckName, parent: season.league.id },
    parent: { id: season.league.id, name: season.league.name, kind: "srs", parent: null },
    dropped,
  };
}

export function convertAll(records: RawQuestion[]): ConvertResult {
  const issues: Issue[] = [];
  const cards: ImportCard[] = [];
  const decks = new Map<string, ImportDeck>();
  const seen = new Set<string>();
  const byDeck: Record<string, number> = {};
  const mediaStats: Record<string, number> = {};
  const unsplitLongAnswers: ConvertResult["stats"]["unsplitLongAnswers"] = [];
  const droppedMedia: ConvertResult["stats"]["droppedMedia"] = [];

  for (const r of records) {
    const result = convertRecord(r);
    if ("problem" in result) {
      issues.push({ qid: r.qid, problem: result.problem });
      continue;
    }
    const { card, deck, parent, dropped } = result;
    if (seen.has(card.id)) {
      issues.push({ qid: r.qid, problem: `duplicate id ${card.id}` });
      continue;
    }
    if (!card.front && !card.media.some((m) => m.side === "front")) {
      issues.push({ qid: r.qid, problem: `${card.id}: empty question` });
      continue;
    }
    seen.add(card.id);
    cards.push(card);
    decks.set(parent.id, parent);
    decks.set(deck.id, deck);
    byDeck[deck.id] = (byDeck[deck.id] ?? 0) + 1;
    for (const m of card.media) mediaStats[`${m.side} ${m.type}`] = (mediaStats[`${m.side} ${m.type}`] ?? 0) + 1;
    for (const url of dropped) droppedMedia.push({ id: card.id, url });
    const meta = card.meta as { notes: string | null; explanation: string | null };
    if (!meta.explanation && !meta.notes && card.back.length > 80) {
      unsplitLongAnswers.push({ id: card.id, answer: card.back });
    }
  }

  cards.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return {
    payload: { decks: [...decks.values()], cards },
    issues,
    stats: {
      records: records.length,
      cards: cards.length,
      byDeck,
      media: mediaStats,
      unsplitLongAnswers,
      droppedMedia,
    },
  };
}
