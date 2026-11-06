import { inArray, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { settings } from "@/db/schema";
import { badRequest } from "./errors";

import { DEFAULT_SETTINGS, type Settings } from "./schedule";

export { afterAgain, afterGood, DEFAULT_SETTINGS, goodsNeeded, inReview, type Settings } from "./schedule";

const KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];

const LIMITS: Record<keyof Settings, [number, number]> = {
  again_gap: [1, 100],
  good_gap: [1, 500],
  learned_after: [1, 10],
  review_gap: [1, 1000],
};

/** Validates one setting; returns the parsed value or throws with a readable message. */
export function parseSetting<K extends keyof Settings>(key: K, value: unknown): Settings[K] {
  const limits = LIMITS[key];
  if (!limits) throw badRequest(`Unknown setting: ${String(key)}`);
  const [min, max] = limits;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw badRequest(`${key} must be a whole number between ${min} and ${max}`);
  }
  return value as Settings[K];
}

export function isSettingKey(key: string): key is keyof Settings {
  return (KEYS as string[]).includes(key);
}

/** Settings are read on every request but change rarely; cache briefly per DB instance. */
const CACHE_TTL_MS = 30_000;
const cache = new WeakMap<DB, { value: Settings; at: number }>();

export async function getSettings(db: DB): Promise<Settings> {
  const hit = cache.get(db);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = await readSettings(db);
  cache.set(db, { value, at: Date.now() });
  return value;
}

async function readSettings(db: DB): Promise<Settings> {
  const rows = await db.select().from(settings).where(inArray(settings.key, KEYS));
  const result = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    if (!isSettingKey(row.key)) continue;
    try {
      (result as Record<string, unknown>)[row.key] = parseSetting(row.key, row.value);
    } catch {
      // Ignore a bad stored value and keep the default.
    }
  }
  return result;
}

export async function updateSettings(db: DB, patch: Record<string, unknown>): Promise<Settings> {
  const entries = Object.entries(patch).map(([key, value]) => {
    if (!isSettingKey(key)) throw badRequest(`Unknown setting: ${key}`);
    return { key, value: parseSetting(key, value) };
  });
  if (entries.length > 0) {
    await db
      .insert(settings)
      .values(entries)
      .onConflictDoUpdate({ target: settings.key, set: { value: sql`excluded.value` } });
  }
  cache.delete(db);
  return getSettings(db);
}
