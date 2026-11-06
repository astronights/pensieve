/**
 * Keyword matching for search (pure), shared by the server's search and the offline copy on the
 * phone: lower-case, without Russian stress marks or Markdown escapes.
 */

/** Combining grave and acute accents: the stress marks on Russian words. */
export const STRESS_MARKS = String.fromCharCode(0x300, 0x301);
const STRESS = new RegExp(`[${STRESS_MARKS}]`, "g");

export const normaliseForSearch = (s: string) =>
  s.normalize("NFD").replace(STRESS, "").normalize("NFC").replace(/\\/g, "").toLowerCase().trim();

/** Keywords from a search box: words, or "quoted phrases" kept together. */
export function searchTerms(query: string): string[] {
  const terms: string[] = [];
  for (const m of query.matchAll(/"([^"]+)"|(\S+)/g)) {
    const t = normaliseForSearch(m[1] ?? m[2]);
    if (t && !terms.includes(t)) terms.push(t);
  }
  return terms.slice(0, 10);
}

/** Everything on a card that search looks at (the same fields as the server's query). */
export function searchableText(card: {
  front: string;
  back: string;
  category: string | null;
  tags: string[];
  meta: Record<string, unknown> | null;
}): string {
  const meta = card.meta ?? {};
  const info = Array.isArray(meta.info)
    ? meta.info.map((i: { label?: unknown; value?: unknown }) =>
        [i?.label, i?.value].filter((x) => x != null).join(" "),
      )
    : [];
  return normaliseForSearch(
    [card.front, card.back, card.category, card.tags.join(" "), meta.notes, meta.explanation, ...info]
      .filter((x) => typeof x === "string" && x !== "")
      .join(" "),
  );
}
