import { drizzle } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import * as schema from "./schema";

/** Any Postgres-backed drizzle instance (node-postgres in the app, PGlite in tests). */
export type DB = PgDatabase<PgQueryResultHKT, typeof schema>;

let db: DB | undefined;

/**
 * One pool per server instance. Neon accepts plain Postgres connections, so the app uses
 * node-postgres everywhere (Neon, local Postgres, CI): production runs the same driver CI tests.
 */
export function getDb(): DB {
  if (!db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    // Keep connections warm between taps: opening a new TLS connection to Neon costs several
    // round trips, which made every answer feel slow with a short idle timeout.
    const pool = new Pool({
      connectionString: url,
      max: 5,
      idleTimeoutMillis: 60_000,
      keepAlive: true,
    });
    // Idle clients can be dropped by the server (e.g. Neon scaling to zero); don't crash on it.
    pool.on("error", (err) => console.error("Postgres pool error", err));
    db = drizzle({ client: pool, schema });
  }
  return db;
}

export { schema };
