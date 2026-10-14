/**
 * Pure helpers that describe a raw ZQL question dump: which fields exist, what they look like,
 * and a small, representative sample of full records. Used by scrape.ts; no I/O here.
 */

export type RawQuestion = Record<string, unknown>;

const TEXT_FIELDS = ["questionText", "answerText"] as const;
const LOW_CARDINALITY_LIMIT = 60;

const truncate = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n)}…` : s);
const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const isEmpty = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

const HTML_TAG_RE = /<\s*([a-zA-Z][a-zA-Z0-9-]*)\b/g;
const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;
const MD_IMAGE_RE = /!\[[^\]]*\]\([^)]+\)/;
const MD_LINK_RE = /(^|[^!])\[[^\]]+\]\([^)]+\)/;

/** Text features worth knowing about before converting Markdown/HTML into card text. */
const FEATURES: Record<string, (s: string) => boolean> = {
  html_tag: (s) => /<\s*[a-zA-Z]/.test(s),
  markdown_image: (s) => MD_IMAGE_RE.test(s),
  markdown_link: (s) => MD_LINK_RE.test(s),
  bold: (s) => /\*\*[^*]+\*\*|__[^_]+__/.test(s),
  italic: (s) => /(^|[^*])\*[^*\s][^*]*\*(?!\*)|(^|\W)_[^_\s][^_]*_(?!\w)/.test(s),
  newline: (s) => s.includes("\n"),
  html_entity: (s) => /&[a-zA-Z#0-9]+;/.test(s),
  list: (s) => /^\s*([-*+]|\d+\.)\s+/m.test(s),
  heading: (s) => /^\s*#{1,6}\s/m.test(s),
  youtube: (s) => /youtu\.?be/.test(s),
  google_drive: (s) => /drive\.google\.com|docs\.google\.com/.test(s),
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "(invalid url)";
  }
}

function countInto(map: Map<string, number>, key: string, by = 1) {
  map.set(key, (map.get(key) ?? 0) + by);
}

const sorted = (m: Map<string, number>) =>
  Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));

export function analyze(records: RawQuestion[]) {
  const fieldNames = new Set<string>();
  for (const r of records) Object.keys(r).forEach((k) => fieldNames.add(k));

  const fields: Record<string, unknown> = {};
  for (const name of [...fieldNames].sort()) {
    const values = records.map((r) => r[name]);
    const present = values.filter((v) => v !== undefined);
    const filled = values.filter((v) => !isEmpty(v));
    const types = new Map<string, number>();
    present.forEach((v) => countInto(types, typeOf(v)));
    const distinct = new Map<string, number>();
    filled.forEach((v) => countInto(distinct, typeof v === "string" ? v : JSON.stringify(v)));
    const examples = [...distinct.keys()].slice(0, 5).map((v) => truncate(v));
    fields[name] = {
      present: present.length,
      filled: filled.length,
      types: sorted(types),
      distinct_values: distinct.size,
      ...(distinct.size <= LOW_CARDINALITY_LIMIT ? { value_counts: sorted(distinct) } : { examples }),
    };
  }

  const text: Record<string, unknown> = {};
  for (const field of TEXT_FIELDS) {
    const features = new Map<string, number>();
    const tags = new Map<string, number>();
    const hosts = new Map<string, number>();
    let maxLength = 0;
    for (const r of records) {
      const s = typeof r[field] === "string" ? (r[field] as string) : "";
      maxLength = Math.max(maxLength, s.length);
      for (const [name, test] of Object.entries(FEATURES)) if (test(s)) countInto(features, name);
      for (const m of s.matchAll(HTML_TAG_RE)) countInto(tags, m[1].toLowerCase());
      for (const m of s.matchAll(URL_RE)) countInto(hosts, hostOf(m[0]));
    }
    text[field] = {
      records_with_feature: sorted(features),
      html_tag_occurrences: sorted(tags),
      url_hosts: sorted(hosts),
      max_length: maxLength,
    };
  }

  const imageHosts = new Map<string, number>();
  let imageAndAnswerMedia = 0;
  for (const r of records) {
    const img = r.imageurl;
    if (typeof img === "string" && img.trim()) {
      countInto(imageHosts, hostOf(img.trim()));
      if (hasMedia(r.answerText)) imageAndAnswerMedia++;
    }
  }

  const keyCounts = new Map<string, number>();
  for (const r of records) countInto(keyCounts, naturalKey(r));
  const duplicateKeys = [...keyCounts.entries()].filter(([, n]) => n > 1).map(([k]) => k);

  return {
    total_records: records.length,
    fields,
    text,
    imageurl: {
      hosts: sorted(imageHosts),
      with_media_in_answer_text_too: imageAndAnswerMedia,
    },
    natural_key: {
      description: "season | gameId | roundNo | questionNo",
      duplicates: duplicateKeys.length,
      duplicate_examples: duplicateKeys.slice(0, 10),
    },
  };
}

function hasMedia(v: unknown): boolean {
  return typeof v === "string" && (/<\s*(img|video|audio|source|iframe)\b/i.test(v) || MD_IMAGE_RE.test(v));
}

function naturalKey(r: RawQuestion): string {
  return [r.season, r.gameId, r.roundNo, r.questionNo].map((v) => String(v ?? "")).join(" | ");
}

/**
 * A small set of complete records that covers the variety in the data: a couple per season,
 * plus examples of every kind of media, link and markup, every `quad` value, and edge cases.
 */
export function pickSample(records: RawQuestion[], perBucket = 3, cap = 80): RawQuestion[] {
  const chosen = new Map<number, string[]>();
  const take = (reason: string, predicate: (r: RawQuestion) => boolean, n = perBucket) => {
    let taken = 0;
    records.forEach((r, i) => {
      if (taken >= n || !predicate(r)) return;
      chosen.set(i, [...(chosen.get(i) ?? []), reason]);
      taken++;
    });
  };
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const both = (r: RawQuestion) => `${str(r.questionText)}\n${str(r.answerText)}`;

  for (const season of new Set(records.map((r) => String(r.season ?? "")))) {
    take(`season ${season}`, (r) => String(r.season ?? "") === season, 2);
  }
  for (const quad of new Set(records.map((r) => String(r.quad ?? "")))) {
    take(`quad ${quad}`, (r) => String(r.quad ?? "") === quad, 1);
  }
  take("has imageurl", (r) => !isEmpty(r.imageurl));
  take("imageurl and media in answer", (r) => !isEmpty(r.imageurl) && hasMedia(r.answerText));
  take("media in question text", (r) => hasMedia(r.questionText));
  take("media in answer text", (r) => hasMedia(r.answerText));
  take("video", (r) => /<\s*video\b/i.test(both(r)));
  take("audio", (r) => /<\s*audio\b/i.test(both(r)));
  take("iframe/embed", (r) => /<\s*(iframe|embed)\b/i.test(both(r)));
  take("youtube", (r) => FEATURES.youtube(both(r)));
  take("google drive", (r) => FEATURES.google_drive(both(r)) || FEATURES.google_drive(str(r.imageurl)));
  take("markdown link", (r) => FEATURES.markdown_link(both(r)));
  take("bold/italic", (r) => FEATURES.bold(both(r)) || FEATURES.italic(both(r)));
  take("list", (r) => FEATURES.list(both(r)));
  take("html entity", (r) => FEATURES.html_entity(both(r)));
  take("empty question text", (r) => isEmpty(r.questionText));
  take("empty answer text", (r) => isEmpty(r.answerText));
  take("missing key part", (r) => [r.season, r.gameId, r.roundNo, r.questionNo].some(isEmpty));
  const tags = new Set<string>();
  records.forEach((r) => {
    for (const m of both(r).matchAll(HTML_TAG_RE)) tags.add(m[1].toLowerCase());
  });
  for (const tag of tags) take(`<${tag}> tag`, (r) => new RegExp(`<\\s*${tag}\\b`, "i").test(both(r)), 1);

  return [...chosen.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(0, cap)
    .map(([i, reasons]) => ({ _sample_reasons: reasons, ...records[i] }));
}
