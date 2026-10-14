import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  doublePrecision,
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
export const cardStage = pgEnum("card_stage", ["new", "learning", "review", "relearning"]);

export type DeckKind = (typeof deckKind.enumValues)[number];
export type CardStage = (typeof cardStage.enumValues)[number];

export const decks = pgTable(
  "decks",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    kind: deckKind("kind").notNull().default("srs"),
    // One level of sub-decks: a sub-deck's parent is always a top-level deck, and a sub-deck
    // always has its parent's kind. Both rules are enforced on import (lib/import.ts).
    parent: text("parent").references((): AnyPgColumn => decks.id),
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
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    category: text("category"),
    media: jsonb("media").$type<MediaItem[]>().notNull().default(sql`'[]'::jsonb`),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("cards_deck_idx").on(t.deck),
    index("cards_deck_category_idx").on(t.deck, t.category),
  ],
);

export const cardState = pgTable(
  "card_state",
  {
    cardId: text("card_id")
      .primaryKey()
      .references(() => cards.id, { onDelete: "cascade" }),
    due: timestamp("due", { withTimezone: true }).notNull(),
    stability: doublePrecision("stability").notNull().default(0),
    difficulty: doublePrecision("difficulty").notNull().default(0),
    state: cardStage("state").notNull().default("new"),
    reps: integer("reps").notNull().default(0),
    lapses: integer("lapses").notNull().default(0),
    // ts-fsrs v5 tracks the position within (re)learning steps; needed to schedule short-term steps.
    learningSteps: integer("learning_steps").notNull().default(0),
    lastReview: timestamp("last_review", { withTimezone: true }),
    bookmarked: boolean("bookmarked").notNull().default(false),
    inReviewQueue: boolean("in_review_queue").notNull().default(false),
  },
  (t) => [index("card_state_due_idx").on(t.due)],
);

export const reviewLog = pgTable(
  "review_log",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    cardId: text("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }).notNull().defaultNow(),
    rating: smallint("rating").notNull(),
    stateBefore: cardStage("state_before").notNull(),
    dueBefore: timestamp("due_before", { withTimezone: true }),
    dueAfter: timestamp("due_after", { withTimezone: true }).notNull(),
    stability: doublePrecision("stability").notNull(),
    difficulty: doublePrecision("difficulty").notNull(),
  },
  (t) => [
    index("review_log_card_idx").on(t.cardId),
    index("review_log_reviewed_at_idx").on(t.reviewedAt),
    check("review_log_rating_check", sql`${t.rating} between 1 and 4`),
  ],
);

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
});
