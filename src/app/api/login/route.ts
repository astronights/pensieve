import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  getPasscode,
  safeEqual,
  safeNextPath,
  sessionToken,
} from "@/lib/auth";

/** Accepts a form post (from /login, works without JS) or JSON `{ passcode }`. */
export async function POST(req: Request) {
  const passcode = getPasscode();
  if (!passcode) return NextResponse.json({ error: "APP_PASSCODE is not configured" }, { status: 503 });

  const isForm = !(req.headers.get("content-type") ?? "").includes("application/json");
  let given: unknown;
  let next: unknown;
  try {
    if (isForm) {
      const form = await req.formData();
      given = form.get("passcode");
      next = form.get("next");
    } else {
      ({ passcode: given, next } = (await req.json()) as Record<string, unknown>);
    }
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const nextPath = safeNextPath(next);
  if (typeof given !== "string" || !safeEqual(given, passcode)) {
    if (isForm) {
      const url = new URL("/login", req.url);
      url.searchParams.set("error", "1");
      url.searchParams.set("next", nextPath);
      return NextResponse.redirect(url, 303);
    }
    return NextResponse.json({ error: "Wrong passcode" }, { status: 401 });
  }

  const res = isForm
    ? NextResponse.redirect(new URL(nextPath, req.url), 303)
    : NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, await sessionToken(passcode), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  return res;
}
