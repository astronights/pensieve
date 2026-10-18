import { inArray, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { settings } from "@/db/schema";
import { badRequest } from "./errors";

export type Settings = {
  /** Again: the card comes back after this many other cards. */
  again_gap: number;
  /** Good: the card comes back after this many cards, doubling with each Good in a row. */
  good_gap: number;
  /** Goods in a row that mark a card as learned; learned cards aren't shown again. */
  learned_after: number;
  /**
   * A card that was ever missed (Again) then needs `learned_after` more Goods in a row, each this
   * many cards apart, before it is learned.
   */
  review_gap: number;
};

export const DEFAULT_SETTINGS: Settings = {
  again_gap: 5,
  good_gap: 15,
  learned_after: 3,
  review_gap: 50,
};

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

/** Goods in a row a card needs to be learned: twice as many once it has been missed. */
export function goodsNeeded(s: Settings, missed: boolean): number {
  return missed ? 2 * s.learned_after : s.learned_after;
}

/** A card in its review stage: missed once, then got the usual Goods in a row. */
export function inReview(s: Settings, streak: number, missed: boolean): boolean {
  return missed && streak >= s.learned_after;
}

/**
 * What Again does: the card's new streak and how many cards later it comes back. In the review
 * stage it stays there (back after `review_gap`, its review Goods restart); otherwise it starts over.
 */
export function afterAgain(s: Settings, streak: number, missed: boolean): { streak: number; gap: number } {
  return inReview(s, streak, missed)
    ? { streak: s.learned_after, gap: s.review_gap }
    : { streak: 0, gap: s.again_gap };
}

/**
 * What a Good that brings the streak to `streak` does: "learned", or how many cards later the card
 * comes back. Learning Goods double the gap (15, 30, …); a missed card's review Goods start
 * `review_gap` apart and double too (50, 100, 200).
 */
export function afterGood(s: Settings, streak: number, missed: boolean): number | "learned" {
  if (streak >= goodsNeeded(s, missed)) return "learned";
  // Review Goods double the gap too: 50, 100, 200, …
  if (streak >= s.learned_after) return s.review_gap * 2 ** (streak - s.learned_after);
  return s.good_gap * 2 ** Math.max(0, streak - 1);
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
