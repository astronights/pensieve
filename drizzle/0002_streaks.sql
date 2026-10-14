CREATE TYPE "public"."answer" AS ENUM('again', 'good', 'seen');--> statement-breakpoint
ALTER TABLE "review_log" DROP CONSTRAINT "review_log_rating_check";--> statement-breakpoint
DROP INDEX "card_state_due_idx";--> statement-breakpoint
DROP INDEX "review_log_reviewed_at_idx";--> statement-breakpoint
ALTER TABLE "card_state" ADD COLUMN "streak" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "card_state" ADD COLUMN "due_at" integer;--> statement-breakpoint
ALTER TABLE "card_state" ADD COLUMN "seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "card_state" ADD COLUMN "learned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "review_log" ADD COLUMN "answer" "answer";--> statement-breakpoint
-- Carry over existing progress: Again (1) stays again, Hard/Good/Easy count as good.
UPDATE "review_log" SET "answer" = CASE WHEN "rating" = 1 THEN 'again'::"answer" ELSE 'good'::"answer" END;--> statement-breakpoint
ALTER TABLE "review_log" ALTER COLUMN "answer" SET NOT NULL;--> statement-breakpoint
-- Cards already being reviewed stay in the queue and come up first; one that had graduated keeps one Good.
UPDATE "card_state" SET
  "seen_at" = "last_review",
  "streak" = CASE WHEN "state" = 'review' THEN 1 ELSE 0 END,
  "due_at" = CASE WHEN "reps" > 0 OR "in_review_queue" THEN 0 END;--> statement-breakpoint
-- Settings that no longer exist.
DELETE FROM "settings" WHERE "key" IN ('daily_new_limit', 'desired_retention', 'timezone');--> statement-breakpoint
CREATE INDEX "card_state_due_at_idx" ON "card_state" USING btree ("due_at");--> statement-breakpoint
ALTER TABLE "card_state" DROP COLUMN "due";--> statement-breakpoint
ALTER TABLE "card_state" DROP COLUMN "stability";--> statement-breakpoint
ALTER TABLE "card_state" DROP COLUMN "difficulty";--> statement-breakpoint
ALTER TABLE "card_state" DROP COLUMN "state";--> statement-breakpoint
ALTER TABLE "card_state" DROP COLUMN "reps";--> statement-breakpoint
ALTER TABLE "card_state" DROP COLUMN "lapses";--> statement-breakpoint
ALTER TABLE "card_state" DROP COLUMN "learning_steps";--> statement-breakpoint
ALTER TABLE "card_state" DROP COLUMN "last_review";--> statement-breakpoint
ALTER TABLE "card_state" DROP COLUMN "in_review_queue";--> statement-breakpoint
ALTER TABLE "review_log" DROP COLUMN "rating";--> statement-breakpoint
ALTER TABLE "review_log" DROP COLUMN "state_before";--> statement-breakpoint
ALTER TABLE "review_log" DROP COLUMN "due_before";--> statement-breakpoint
ALTER TABLE "review_log" DROP COLUMN "due_after";--> statement-breakpoint
ALTER TABLE "review_log" DROP COLUMN "stability";--> statement-breakpoint
ALTER TABLE "review_log" DROP COLUMN "difficulty";--> statement-breakpoint
DROP TYPE "public"."card_stage";