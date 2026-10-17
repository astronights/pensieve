import { describe, expect, it } from "vitest";
import { skipReason } from "../scripts/migrate";

describe("migrations on deploy", () => {
  it("run on production deploys, locally and in CI", () => {
    expect(skipReason("production")).toBeNull();
    expect(skipReason(undefined)).toBeNull();
  });

  it("are skipped on preview and development builds, which share the production database", () => {
    expect(skipReason("preview")).toMatch(/preview build/);
    expect(skipReason("development")).toMatch(/development build/);
  });
});
