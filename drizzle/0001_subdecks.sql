ALTER TABLE "decks" ADD COLUMN "parent" text;--> statement-breakpoint
ALTER TABLE "decks" ADD CONSTRAINT "decks_parent_decks_id_fk" FOREIGN KEY ("parent") REFERENCES "public"."decks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "decks_parent_idx" ON "decks" USING btree ("parent");