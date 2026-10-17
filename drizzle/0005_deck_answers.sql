ALTER TABLE "decks" ADD COLUMN "answers" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Each top-level deck counts the answers given in it and its sub-decks.
UPDATE "decks" "t" SET "answers" = (
  SELECT count(*) FROM "review_log" "l"
  JOIN "cards" "c" ON "c"."id" = "l"."card_id"
  JOIN "decks" "d" ON "d"."id" = "c"."deck"
  WHERE coalesce("d"."parent", "d"."id") = "t"."id"
) WHERE "t"."parent" IS NULL;--> statement-breakpoint
-- Cards being learned were placed on one shared count (the latest review_log id). Move them onto
-- their deck's own count, keeping how far each is from its turn, so the queue order is unchanged.
UPDATE "card_state" "cs" SET "due_at" = "cs"."due_at" - (SELECT coalesce(max("id"), 0) FROM "review_log") + "g"."answers"
FROM "cards" "c"
JOIN "decks" "d" ON "d"."id" = "c"."deck"
JOIN "decks" "g" ON "g"."id" = coalesce("d"."parent", "d"."id")
WHERE "c"."id" = "cs"."card_id" AND "cs"."due_at" IS NOT NULL;
