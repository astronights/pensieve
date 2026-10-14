-- Remove the demo decks seeded by earlier deploys (SEED_DEMO=1). Their card_state and review_log
-- rows go with the cards (on delete cascade). Sub-decks before their parents. Setting SEED_DEMO=1
-- adds them back on the next deploy, since seeding runs after migrations.
DELETE FROM "cards" WHERE "deck" LIKE 'demo-%';--> statement-breakpoint
DELETE FROM "decks" WHERE "parent" LIKE 'demo-%';--> statement-breakpoint
DELETE FROM "decks" WHERE "id" LIKE 'demo-%';
