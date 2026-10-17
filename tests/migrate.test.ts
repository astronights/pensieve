import { describe, expect, it } from "vitest";
import { skipReason } from "../scripts/migrate";

describe("migrations on deploy", () => {
  it("run on production deploys, locally and in CI", () => {
    expect(skipReason({ VERCEL_ENV: "production" })).toBeNull();
    expect(skipReason({})).toBeNull();
  });

  it("are skipped on preview and development builds, which share the production database", () => {
    expect(skipReason({ VERCEL_ENV: "preview" })).toMatch(/preview build/);
    expect(skipReason({ VERCEL_ENV: "development" })).toMatch(/development build/);
  });
});
