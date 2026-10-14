CREATE TYPE "public"."card_stage" AS ENUM('new', 'learning', 'review', 'relearning');--> statement-breakpoint
CREATE TYPE "public"."deck_kind" AS ENUM('srs', 'browse');--> statement-breakpoint
CREATE TABLE "card_state" (
	"card_id" text PRIMARY KEY NOT NULL,
	"due" timestamp with time zone NOT NULL,
	"stability" double precision DEFAULT 0 NOT NULL,
	"difficulty" double precision DEFAULT 0 NOT NULL,
	"state" "card_stage" DEFAULT 'new' NOT NULL,
	"reps" integer DEFAULT 0 NOT NULL,
	"lapses" integer DEFAULT 0 NOT NULL,
	"learning_steps" integer DEFAULT 0 NOT NULL,
	"last_review" timestamp with time zone,
	"bookmarked" boolean DEFAULT false NOT NULL,
	"in_review_queue" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cards" (
	"id" text PRIMARY KEY NOT NULL,
	"deck" text NOT NULL,
	"front" text NOT NULL,
	"back" text NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"category" text,
	"media" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decks" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" "deck_kind" DEFAULT 'srs' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"card_id" text NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rating" smallint NOT NULL,
	"state_before" "card_stage" NOT NULL,
	"due_before" timestamp with time zone,
	"due_after" timestamp with time zone NOT NULL,
	"stability" double precision NOT NULL,
	"difficulty" double precision NOT NULL,
	CONSTRAINT "review_log_rating_check" CHECK ("review_log"."rating" between 1 and 4)
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "card_state" ADD CONSTRAINT "card_state_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_deck_decks_id_fk" FOREIGN KEY ("deck") REFERENCES "public"."decks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_log" ADD CONSTRAINT "review_log_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "card_state_due_idx" ON "card_state" USING btree ("due");--> statement-breakpoint
CREATE INDEX "cards_deck_idx" ON "cards" USING btree ("deck");--> statement-breakpoint
CREATE INDEX "cards_deck_category_idx" ON "cards" USING btree ("deck","category");--> statement-breakpoint
CREATE INDEX "review_log_card_idx" ON "review_log" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX "review_log_reviewed_at_idx" ON "review_log" USING btree ("reviewed_at");