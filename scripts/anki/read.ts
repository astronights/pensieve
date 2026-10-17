/**
 * Reads an Anki export (.apkg deck package or .colpkg collection) into plain objects.
 *
 * An export is a zip holding a SQLite collection. Newer Anki writes `collection.anki21b`
 * (zstd-compressed, schema 18: note types, fields, templates and decks in their own tables);
 * older Anki, or "Support older Anki versions", writes `collection.anki21` / `collection.anki2`
 * (note types and decks as JSON in the `col` table). Both are handled.
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { unzipSync } from "fflate";
import { decompress } from "fzstd";
import initSqlJs, { type Database } from "sql.js";

export type AnkiDeck = { id: string; name: string };
export type AnkiTemplate = { name: string; front: string; back: string };
export type AnkiNoteType = {
  id: string;
  name: string;
  kind: "standard" | "cloze";
  fields: string[];
  templates: AnkiTemplate[];
};
export type AnkiNote = { id: string; guid: string; typeId: string; fields: string[]; tags: string[] };
/** One Anki card: a note rendered with one template (or one cloze number), in a deck. */
export type AnkiCard = { id: string; noteId: string; deckId: string; ord: number };

export type AnkiCollection = {
  format: "anki21b" | "anki21" | "anki2";
  decks: AnkiDeck[];
  noteTypes: AnkiNoteType[];
  notes: AnkiNote[];
  cards: AnkiCard[];
  /** Media files packed in the export (not imported; Pensieve only links to external media). */
  mediaFiles: number;
};

const FIELD_SEP = "\x1f";

async function openSqlite(bytes: Uint8Array): Promise<Database> {
  // Resolved from the project root so this works whether scripts run as CommonJS or ESM.
  const req = createRequire(path.join(process.cwd(), "package.json"));
  const SQL = await initSqlJs({ locateFile: (f) => req.resolve(`sql.js/dist/${f}`) });
  const db = new SQL.Database(bytes);
  // Newer collections use Anki's own "unicase" collation, which SQLite here doesn't have, so it
  // can't query those tables. This is an in-memory copy: drop the collation from its schema and
  // reopen it.
  const [{ n }] = rows<{ n: number }>(db, "select count(*) as n from sqlite_master where sql like '%collate unicase%'");
  if (n === 0) return db;
  db.run("pragma writable_schema = on");
  db.run("update sqlite_master set sql = replace(replace(sql, 'COLLATE unicase', ''), 'collate unicase', '')");
  db.run("pragma writable_schema = off");
  const patched = db.export();
  db.close();
  return new SQL.Database(patched);
}

function rows<T>(db: Database, sql: string): T[] {
  const stmt = db.prepare(sql);
  const out: T[] = [];
  while (stmt.step()) out.push(stmt.getAsObject() as T);
  stmt.free();
  return out;
}

/** Minimal protobuf reader: the varint and string fields we need from schema-18 config blobs. */
function protoFields(buf: Uint8Array): Map<number, (number | string)[]> {
  const out = new Map<number, (number | string)[]>();
  let i = 0;
  const varint = () => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = buf[i++];
      result += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) return result;
      shift += 7;
    }
  };
  const push = (field: number, value: number | string) => out.set(field, [...(out.get(field) ?? []), value]);
  while (i < buf.length) {
    const key = varint();
    const field = Math.floor(key / 8);
    const wire = key & 7;
    if (wire === 0) push(field, varint());
    else if (wire === 2) {
      const len = varint();
      push(field, new TextDecoder().decode(buf.subarray(i, i + len)));
      i += len;
    } else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else break; // groups are not used by Anki
  }
  return out;
}

const splitTags = (tags: string) => tags.split(" ").filter(Boolean);

function readModern(db: Database): Omit<AnkiCollection, "format" | "mediaFiles"> {
  const decks = rows<{ id: number; name: string }>(db, "select id, name from decks").map((d) => ({
    id: String(d.id),
    name: d.name.split(FIELD_SEP).join("::"),
  }));
  const fields = rows<{ ntid: number; ord: number; name: string }>(db, "select ntid, ord, name from fields order by ntid, ord");
  const templates = rows<{ ntid: number; ord: number; name: string; config: Uint8Array }>(
    db,
    "select ntid, ord, name, config from templates order by ntid, ord",
  );
  const noteTypes = rows<{ id: number; name: string; config: Uint8Array }>(db, "select id, name, config from notetypes").map(
    (nt): AnkiNoteType => ({
      id: String(nt.id),
      name: nt.name,
      // NotetypeConfig.kind (field 1): 0 normal (omitted), 1 cloze.
      kind: protoFields(nt.config).get(1)?.[0] === 1 ? "cloze" : "standard",
      fields: fields.filter((f) => f.ntid === nt.id).map((f) => f.name),
      templates: templates
        .filter((t) => t.ntid === nt.id)
        .map((t) => {
          // TemplateConfig: q_format = 1, a_format = 2.
          const cfg = protoFields(t.config);
          return { name: t.name, front: String(cfg.get(1)?.[0] ?? ""), back: String(cfg.get(2)?.[0] ?? "") };
        }),
    }),
  );
  return { decks, noteTypes, ...readNotesAndCards(db) };
}

function readLegacy(db: Database): Omit<AnkiCollection, "format" | "mediaFiles"> {
  const [col] = rows<{ models: string; decks: string }>(db, "select models, decks from col");
  type LegacyModel = {
    id: number;
    name: string;
    type: number;
    flds: { name: string; ord: number }[];
    tmpls: { name: string; ord: number; qfmt: string; afmt: string }[];
  };
  const models = Object.values(JSON.parse(col.models) as Record<string, LegacyModel>);
  const decks = Object.values(JSON.parse(col.decks) as Record<string, { id: number; name: string }>).map((d) => ({
    id: String(d.id),
    name: d.name,
  }));
  const noteTypes = models.map(
    (m): AnkiNoteType => ({
      id: String(m.id),
      name: m.name,
      kind: m.type === 1 ? "cloze" : "standard",
      fields: [...m.flds].sort((a, b) => a.ord - b.ord).map((f) => f.name),
      templates: [...m.tmpls].sort((a, b) => a.ord - b.ord).map((t) => ({ name: t.name, front: t.qfmt, back: t.afmt })),
    }),
  );
  return { decks, noteTypes, ...readNotesAndCards(db) };
}

function readNotesAndCards(db: Database) {
  const notes = rows<{ id: number; guid: string; mid: number; flds: string; tags: string }>(
    db,
    "select id, guid, mid, flds, tags from notes order by id",
  ).map((n): AnkiNote => ({
    id: String(n.id),
    guid: n.guid,
    typeId: String(n.mid),
    fields: n.flds.split(FIELD_SEP),
    tags: splitTags(n.tags),
  }));
  const cards = rows<{ id: number; nid: number; did: number; ord: number }>(
    db,
    "select id, nid, did, ord from cards order by nid, ord",
  ).map((c): AnkiCard => ({ id: String(c.id), noteId: String(c.nid), deckId: String(c.did), ord: c.ord }));
  return { notes, cards };
}

export async function readAnkiExport(file: string): Promise<AnkiCollection> {
  const notExport = `${file} isn't an Anki export. In Anki use File → Export… and pick "Anki Deck Package (.apkg)" or "Anki Collection Package (.colpkg)".`;
  let zip: Record<string, Uint8Array>;
  try {
    zip = unzipSync(new Uint8Array(await readFile(file)));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`File not found: ${file}`);
    throw new Error(notExport);
  }
  const mediaFiles = Object.keys(zip).filter((name) => /^\d+$/.test(name)).length;

  if (zip["collection.anki21b"]) {
    const db = await openSqlite(decompress(zip["collection.anki21b"]));
    try {
      return { format: "anki21b", mediaFiles, ...readModern(db) };
    } finally {
      db.close();
    }
  }
  const legacyName = zip["collection.anki21"] ? "collection.anki21" : zip["collection.anki2"] ? "collection.anki2" : null;
  if (!legacyName) {
    throw new Error(notExport);
  }
  const db = await openSqlite(zip[legacyName]);
  try {
    // Some Anki versions add a placeholder collection that only tells old clients to update.
    return { format: legacyName === "collection.anki21" ? "anki21" : "anki2", mediaFiles, ...readLegacy(db) };
  } finally {
    db.close();
  }
}
