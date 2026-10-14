import { config } from "dotenv";

config({ path: ".env.local", quiet: true });

async function main() {
  const { getDb } = await import("@/db");
  const { importCards } = await import("@/lib/import");
  const { SEED } = await import("@/lib/seed-data");
  const result = await importCards(getDb(), SEED);
  console.log(`Seeded ${result.cards} cards into ${result.decks} decks.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
