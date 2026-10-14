import { describe, expect, it } from "vitest";
import { isAuthorized, safeEqual, safeNextPath, sessionToken } from "@/lib/auth";

describe("auth helpers", () => {
  it("derives a stable token that differs from the passcode", async () => {
    const a = await sessionToken("secret");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(await sessionToken("secret"));
    expect(a).not.toBe(await sessionToken("other"));
    expect(a).not.toContain("secret");
  });

  it("compares strings safely", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });

  it("accepts a valid cookie or bearer token only", async () => {
    const token = await sessionToken("pw");
    expect(await isAuthorized("pw", { cookie: token })).toBe(true);
    expect(await isAuthorized("pw", { authorization: "Bearer pw" })).toBe(true);
    expect(await isAuthorized("pw", { cookie: "pw" })).toBe(false);
    expect(await isAuthorized("pw", { authorization: "Bearer nope" })).toBe(false);
    expect(await isAuthorized("pw", {})).toBe(false);
  });

  it("only allows same-site relative redirects", () => {
    expect(safeNextPath("/study/x?a=1")).toBe("/study/x?a=1");
    expect(safeNextPath("//evil.com")).toBe("/");
    expect(safeNextPath("/\\evil.com")).toBe("/");
    expect(safeNextPath("https://evil.com")).toBe("/");
    expect(safeNextPath(undefined)).toBe("/");
  });
});
