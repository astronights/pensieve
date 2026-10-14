export const SESSION_COOKIE = "pensieve_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 365; // one year

const encoder = new TextEncoder();

/**
 * The cookie holds HMAC(passcode, label) rather than the passcode itself.
 * Changing APP_PASSCODE therefore invalidates every existing session.
 */
export async function sessionToken(passcode: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(passcode),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode("pensieve-session-v1"));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison (length is not secret here). */
export function safeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  let diff = ab.length ^ bb.length;
  const n = Math.max(ab.length, bb.length);
  for (let i = 0; i < n; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

export function getPasscode(): string | undefined {
  const p = process.env.APP_PASSCODE;
  return p && p.length > 0 ? p : undefined;
}

export type AuthInput = { cookie?: string | null; authorization?: string | null };

/** True if the request carries a valid session cookie or `Authorization: Bearer <APP_PASSCODE>`. */
export async function isAuthorized(passcode: string, input: AuthInput): Promise<boolean> {
  const bearer = input.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer && safeEqual(bearer, passcode)) return true;
  if (input.cookie && safeEqual(input.cookie, await sessionToken(passcode))) return true;
  return false;
}

/** Only allow same-site relative redirect targets after login. */
export function safeNextPath(next: unknown): string {
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) {
    return "/";
  }
  return next;
}
