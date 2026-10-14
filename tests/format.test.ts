import { describe, expect, it } from "vitest";
import { formatInterval } from "@/lib/format";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

describe("formatInterval", () => {
  it.each([
    [30_000, "<1m"],
    [MIN, "1m"],
    [10 * MIN, "10m"],
    [5 * 60 * MIN, "5h"],
    [8 * DAY, "8d"],
    [46 * DAY, "1.5mo"],
    [11 * 30.44 * DAY, "11mo"],
    [400 * DAY, "1.1y"],
  ])("%d ms → %s", (ms, label) => {
    expect(formatInterval(ms)).toBe(label);
  });
});
