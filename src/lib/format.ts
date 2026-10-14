const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Compact interval for button labels: "<1m", "10m", "5h", "8d", "1.5mo", "2y". */
export function formatInterval(ms: number): string {
  if (ms < MIN) return "<1m";
  if (ms < HOUR) return `${Math.round(ms / MIN)}m`;
  if (ms < DAY) return `${Math.round(ms / HOUR)}h`;
  const days = ms / DAY;
  if (days < 30) return `${Math.round(days)}d`;
  const months = days / 30.44;
  if (months < 12) return `${months < 10 ? Math.round(months * 10) / 10 : Math.round(months)}mo`;
  const years = days / 365.25;
  return `${years < 10 ? Math.round(years * 10) / 10 : Math.round(years)}y`;
}
