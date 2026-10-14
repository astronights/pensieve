import { expect, test } from "@playwright/test";

const PASSCODE = process.env.APP_PASSCODE ?? "";

test.beforeEach(async ({ page }) => {
  // Block external media so the "media unavailable" fallback path is exercised deterministically.
  await page.route(/^https?:\/\/(?!localhost)/, (route) => route.abort());
});

test("API rejects requests without the passcode", async ({ request }) => {
  const res = await request.get("/api/decks");
  expect(res.status()).toBe(401);
});

test("login → deck list → SRS study loop", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await page.getByPlaceholder("Passcode").fill("wrong");
  await page.getByRole("button", { name: "Enter" }).click();
  await expect(page.getByText("Wrong passcode.")).toBeVisible();

  await page.getByPlaceholder("Passcode").fill(PASSCODE);
  await page.getByRole("button", { name: "Enter" }).click();
  await expect(page.getByRole("heading", { name: "Pensieve" })).toBeVisible();

  await page.getByRole("link", { name: /Spanish \(demo\)/ }).click();
  await expect(page).toHaveURL(/\/study\/demo-spanish/);

  // Study all 12 new cards (Easy), including the ones whose media fails to load.
  for (let i = 0; i < 12; i++) {
    await page.getByRole("button", { name: "Show answer" }).click();
    await page.getByRole("button", { name: "Easy" }).click();
  }
  await expect(page.getByText(/Nothing left in Spanish/)).toBeVisible();
});

test("media failures show a note but keep the card text", async ({ page, context }) => {
  await context.request.post("/api/login", { data: { passcode: PASSCODE } });

  await page.goto("/study/demo-trivia?category=animals&season=S2");
  await expect(page.locator(".card-text").first()).toBeVisible();
  await expect(page.getByText("media unavailable").first()).toBeVisible();
});

test("browse deck: Again sends the card to review, Next just moves on", async ({ page, context }) => {
  await context.request.post("/api/login", { data: { passcode: PASSCODE } });
  await page.goto("/study/demo-trivia?category=science");

  await page.getByRole("button", { name: "Show answer" }).click();
  await expect(page.getByRole("button", { name: "Add to review" })).toBeVisible();
  await page.getByRole("button", { name: "Again" }).click();

  await page.getByRole("button", { name: "Show answer" }).click();
  // Answers save in the background; wait for that save before checking counts.
  const saved = page.waitForResponse((r) => r.url().endsWith("/api/review") && r.ok());
  await page.getByRole("button", { name: "Next" }).click();
  await saved;

  const decks = await (await context.request.get("/api/decks")).json();
  const trivia = decks.decks.find((d: { id: string }) => d.id === "demo-trivia");
  expect(trivia.unseen).toBe(6);
});

test("settings page saves values", async ({ page, context }) => {
  await context.request.post("/api/login", { data: { passcode: PASSCODE } });
  await page.goto("/");
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

  const limit = page.getByLabel(/New cards per day/);
  await expect(limit).toHaveValue("15");
  await limit.fill("20");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();

  const settings = await (await context.request.get("/api/settings")).json();
  expect(settings.daily_new_limit).toBe(20);

  await page.getByRole("link", { name: "Decks" }).click();
  await expect(page.getByRole("heading", { name: "Pensieve" })).toBeVisible();
});
