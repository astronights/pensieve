import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export type MediaItem = {
  type: "image" | "video" | "audio";
  /** External URL only; we never host or download media. */
  url: string;
  side: "front" | "back";
};

export const deckKind = pgEnum("deck_kind", ["srs", "browse"]);

export type DeckKind = (typeof deckKind.enumValues)[number];

export const decks = pgTable(
  "decks",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    kind: deckKind("kind").notNull().default("srs"),
    // One level of sub-decks: a sub-deck's parent is always a top-level deck, and a sub-deck
    // always has its parent's kind. Both rules are enforced on import (lib/import.ts).
    parent: text("parent").references((): AnyPgColumn => decks.id),
    // Answers given in this deck and its sub-decks (kept on top-level decks). "Back after N cards"
    // counts these, so studying one deck doesn't move another deck's cards along.
    answers: integer("answers").notNull().default(0),
  },
  (t) => [index("decks_parent_idx").on(t.parent)],
);

export const cards = pgTable(
  "cards",
  {
    // Stable, importer-supplied IDs ("zql:S1:G3:2:5", "anki:<guid>") so re-imports keep progress.
    id: text("id").primaryKey(),
    deck: text("deck")
      .notNull()
      .references(() => decks.id),
    front: text("front").notNull(),
    back: text("back").notNull(),
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    category: text("category"),
    media: jsonb("media")
      .$type<MediaItem[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("cards_deck_idx").on(t.deck), index("cards_deck_category_idx").on(t.deck, t.category)],
);

export const cardState = pgTable(
  "card_state",
  {
    cardId: text("card_id")
      .primaryKey()
      .references(() => cards.id, { onDelete: "cascade" }),
    // Goods in a row; reaching the "learned after" setting retires the card.
    streak: smallint("streak").notNull().default(0),
    // The card comes back once the answer counter (the latest review_log id) reaches this.
    // Null when the card isn't being learned: never answered, only seen (browse) or learned.
    dueAt: integer("due_at"),
    seenAt: timestamp("seen_at", { withTimezone: true }),
    learnedAt: timestamp("learned_at", { withTimezone: true }),
    // Answered Again at least once. Such a card needs extra, widely spaced Goods before it's learned.
    missed: boolean("missed").notNull().default(false),
    bookmarked: boolean("bookmarked").notNull().default(false),
  },
  (t) => [index("card_state_due_at_idx").on(t.dueAt)],
);

export const answerKind = pgEnum("answer", ["again", "good", "seen"]);
export type Answer = (typeof answerKind.enumValues)[number];

/** One row per answer. Its id doubles as the answer counter that positions cards in the queue. */
export const reviewLog = pgTable(
  "review_log",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    cardId: text("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }).notNull().defaultNow(),
    answer: answerKind("answer").notNull(),
  },
  (t) => [index("review_log_card_idx").on(t.cardId)],
);

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
});
