/**
 * Optional, source-agnostic extras an importer can put in `card.meta` to enrich the back of a card.
 * All text is Markdown.
 *   notes        marking guidance, e.g. "Accept: Kiswahili" (shown small, under the answer)
 *   explanation  background shown after the answer
 *   info         small label/value lines in the card footer, e.g. { label: "Topic", value: "…" }
 *   raw          the untouched source record (stored for reference, never sent to the client)
 */
export type InfoLine = { label: string; value: string };
export type CardExtras = { notes: string | null; explanation: string | null; info: InfoLine[] };

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);

export function cardExtras(meta: Record<string, unknown> | null | undefined): CardExtras {
  const info = Array.isArray(meta?.info)
    ? meta.info.filter(
        (l): l is InfoLine =>
          !!l && typeof l === "object" && typeof l.label === "string" && typeof l.value === "string",
      )
    : [];
  return { notes: str(meta?.notes), explanation: str(meta?.explanation), info };
}

/** Meta as sent to the browser: everything except the (potentially large) raw source record. */
export function clientMeta(meta: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!meta || !("raw" in meta)) return meta;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { raw, ...rest } = meta;
  return rest;
}
