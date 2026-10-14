import { inArray, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { settings } from "@/db/schema";
import { badRequest } from "./errors";

export type Settings = {
  daily_new_limit: number;
  desired_retention: number;
  /** IANA zone used to decide when "today" starts for the daily new-card cap. */
  timezone: string;
};

export const DEFAULT_SETTINGS: Settings = {
  daily_new_limit: 15,
  desired_retention: 0.9,
  timezone: "UTC",
};

const KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Validates one setting; returns the parsed value or throws with a readable message. */
export function parseSetting<K extends keyof Settings>(key: K, value: unknown): Settings[K] {
  switch (key) {
    case "daily_new_limit":
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1000) {
        throw badRequest("daily_new_limit must be an integer between 0 and 1000");
      }
      return value as Settings[K];
    case "desired_retention":
      if (typeof value !== "number" || !(value >= 0.7 && value <= 0.99)) {
        throw badRequest("desired_retention must be a number between 0.70 and 0.99");
      }
      return value as Settings[K];
    case "timezone":
      if (typeof value !== "string" || !isValidTimeZone(value)) {
        throw badRequest("timezone must be a valid IANA time zone, e.g. Europe/London");
      }
      return value as Settings[K];
    default:
      throw badRequest(`Unknown setting: ${String(key)}`);
  }
}

export function isSettingKey(key: string): key is keyof Settings {
  return (KEYS as string[]).includes(key);
}

export async function getSettings(db: DB): Promise<Settings> {
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
  return getSettings(db);
}
