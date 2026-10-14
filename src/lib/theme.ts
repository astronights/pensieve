/** Per-device appearance, stored in a cookie so the server renders the right theme (no flash). */
export const THEME_COOKIE = "theme";
export type Theme = "system" | "light" | "dark";

export function parseTheme(value: string | undefined | null): Theme {
  return value === "light" || value === "dark" ? value : "system";
}
