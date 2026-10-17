ALTER TABLE "card_state" ADD COLUMN "missed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Cards answered Again at some point.
UPDATE "card_state" SET "missed" = true
WHERE "card_id" IN (SELECT DISTINCT "card_id" FROM "review_log" WHERE "answer" = 'again');--> statement-breakpoint
-- Missed cards that were already learned go back to their review stage: they come up again 50
-- cards from now and need more Goods in a row (their streak continues from "learned after").
UPDATE "card_state" SET
  "learned_at" = NULL,
  "streak" = COALESCE((SELECT ("value" #>> '{}')::int FROM "settings" WHERE "key" = 'learned_after'), 3),
  "due_at" = (SELECT COALESCE(MAX("id"), 0) FROM "review_log") + 50
WHERE "missed" AND "learned_at" IS NOT NULL;
