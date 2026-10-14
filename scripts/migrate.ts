/**
 * Applies pending migrations from ./drizzle. Runs on every Vercel deploy (see `vercel-build`).
 * Set SEED_DEMO=1 to also upsert the 20 demo cards (idempotent; progress is never reset).
 */
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

config({ path: ".env.local", quiet: true });

async function main() {
  // Prefer a direct (non-pooled) connection for DDL when one is provided.
  const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set. Add it in Vercel → Settings → Environment Variables.");
  }

  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const db = drizzle({ client: pool });
    await migrate(db, { migrationsFolder: "./drizzle" });
    console.log("Migrations applied.");

    if (process.env.SEED_DEMO === "1") {
      const schema = await import("@/db/schema");
      const { importCards } = await import("@/lib/import");
      const { SEED } = await import("@/lib/seed-data");
      const result = await importCards(drizzle({ client: pool, schema }), SEED);
      console.log(`Seeded ${result.cards} demo cards into ${result.decks} decks.`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
