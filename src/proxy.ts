import { type NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, getPasscode, isAuthorized } from "@/lib/auth";

const PUBLIC_PATHS = new Set(["/login", "/api/login"]);

export async function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const isApi = pathname.startsWith("/api/");
  const passcode = getPasscode();

  if (!passcode) {
    // Fail closed: never serve anything if the passcode isn't configured.
    return new NextResponse("APP_PASSCODE is not configured", { status: 503 });
  }
  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();

  const ok = await isAuthorized(passcode, {
    cookie: req.cookies.get(SESSION_COOKIE)?.value,
    authorization: req.headers.get("authorization"),
  });
  if (ok) return NextResponse.next();

  if (isApi) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const login = new URL("/login", req.url);
  login.searchParams.set("next", pathname + search);
  return NextResponse.redirect(login);
}

export const config = {
  // Everything except Next's static assets and the favicon.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
