import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE, sessionToken } from "@/lib/auth";
import { proxy } from "@/proxy";

const req = (path: string, headers: Record<string, string> = {}) =>
  new NextRequest(new URL(path, "http://localhost"), { headers });

describe("proxy (passcode gate)", () => {
  const original = process.env.APP_PASSCODE;
  beforeEach(() => {
    process.env.APP_PASSCODE = "letmein";
  });
  afterEach(() => {
    process.env.APP_PASSCODE = original;
  });

  it("returns 401 JSON for unauthenticated API calls", async () => {
    for (const path of ["/api/decks", "/api/next?deck=x", "/api/review", "/api/import", "/api/settings"]) {
      const res = await proxy(req(path));
      expect(res.status, path).toBe(401);
    }
  });

  it("redirects unauthenticated pages to /login with next", async () => {
    const res = await proxy(req("/study/demo?season=S1"));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/study/demo?season=S1");
  });

  it("lets the login page and login API through", async () => {
    expect((await proxy(req("/login"))).headers.get("x-middleware-next")).toBe("1");
    expect((await proxy(req("/api/login"))).headers.get("x-middleware-next")).toBe("1");
  });

  it("accepts the session cookie", async () => {
    const cookie = `${SESSION_COOKIE}=${await sessionToken("letmein")}`;
    const res = await proxy(req("/api/decks", { cookie }));
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("rejects a cookie minted for a different passcode", async () => {
    const cookie = `${SESSION_COOKIE}=${await sessionToken("old-passcode")}`;
    expect((await proxy(req("/api/decks", { cookie }))).status).toBe(401);
  });

  it("accepts a bearer passcode (for importer scripts)", async () => {
    const res = await proxy(req("/api/import", { authorization: "Bearer letmein" }));
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("fails closed when APP_PASSCODE is missing", async () => {
    delete process.env.APP_PASSCODE;
    expect((await proxy(req("/api/decks"))).status).toBe(503);
    expect((await proxy(req("/login"))).status).toBe(503);
  });
});
