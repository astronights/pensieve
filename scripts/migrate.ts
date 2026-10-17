/**
 * Applies pending migrations from ./drizzle. Runs on Vercel deploys (see `vercel-build`).
 * Set SEED_DEMO=1 to also upsert the 20 demo cards (idempotent; progress is never reset).
 *
 * Only production deploys touch the database: Vercel also builds a preview for every pull request,
 * and preview and production share one database, so a preview build must not change its schema
 * before the pull request is merged. Local runs and CI (no VERCEL_ENV) always migrate.
 */
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

config({ path: ".env.local", quiet: true });

/** Why migrations are skipped in this environment, or null to run them. */
export function skipReason(env: { VERCEL_ENV?: string }): string | null {
  const target = env.VERCEL_ENV;
  if (target && target !== "production") return `Skipping migrations: this is a ${target} build, not production.`;
  return null;
}

async function main() {
  const skip = skipReason(process.env);
  if (skip) {
    console.log(skip);
    return;
  }

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

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
