import { neonConfig, Pool as NeonPool } from "@neondatabase/serverless";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { Pool as PgPool } from "pg";
import ws from "ws";
import * as schema from "./schema";

/** Any Postgres-backed drizzle instance (Neon in prod, plain Postgres locally/CI, PGlite in tests). */
export type DB = PgDatabase<PgQueryResultHKT, typeof schema>;

neonConfig.webSocketConstructor = ws;

let db: DB | undefined;

export function isNeonUrl(url: string): boolean {
  return new URL(url).hostname.endsWith(".neon.tech");
}

export function getDb(): DB {
  if (!db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    db = isNeonUrl(url)
      ? drizzleNeon({ client: new NeonPool({ connectionString: url }), schema })
      : drizzlePg({ client: new PgPool({ connectionString: url }), schema });
  }
  return db;
}

export { schema };
