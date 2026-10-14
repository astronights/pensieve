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

test("appearance can be forced to light or dark and is remembered", async ({ page, context }) => {
  await context.request.post("/api/login", { data: { passcode: PASSCODE } });
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/settings");
  const html = page.locator("html");
  await expect(html).not.toHaveAttribute("data-theme", /.*/);

  await page.getByRole("button", { name: "Dark" }).click();
  await expect(html).toHaveAttribute("data-theme", "dark");
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(await bg()).toBe("rgb(12, 10, 9)");

  // Remembered across reloads and pages (rendered by the server, no flash).
  await page.goto("/");
  await expect(html).toHaveAttribute("data-theme", "dark");

  await page.goto("/settings");
  await page.getByRole("button", { name: "System" }).click();
  await expect(html).not.toHaveAttribute("data-theme", /.*/);
  expect(await bg()).toBe("rgb(250, 250, 249)");
});

test("sub-decks: expand a parent and study one sub-deck", async ({ page, context }) => {
  await context.request.post("/api/login", { data: { passcode: PASSCODE } });
  await page.goto("/");
  await expect(page.getByRole("link", { name: /Basics/ })).toHaveCount(0);

  await page.getByRole("button", { name: "Show sub-decks of Spanish (demo)" }).click();
  await expect(page.getByRole("link", { name: /With media/ })).toBeVisible();

  // Stays open after a reload (remembered on this device).
  await page.reload();
  await page.getByRole("link", { name: /Basics/ }).click();
  await expect(page).toHaveURL(/\/study\/demo-spanish-basics/);

  // Earlier tests may have studied these cards already, so either a card or "nothing left" is fine.
  await expect(
    page.getByRole("button", { name: "Show answer" }).or(page.getByText(/Nothing left in Basics/)),
  ).toBeVisible();

  const { decks } = await (await context.request.get("/api/decks")).json();
  const basics = decks.find((d: { id: string }) => d.id === "demo-spanish-basics");
  expect(basics).toMatchObject({ parent: "demo-spanish", kind: "srs" });
});

test("Markdown, notes, explanation and info show only after the reveal", async ({ page, context }) => {
  const auth = { Authorization: `Bearer ${PASSCODE}` };
  const res = await context.request.post("/api/import", {
    headers: auth,
    data: {
      decks: [{ id: "e2e-md", name: "Markdown test", kind: "srs" }],
      cards: [
        {
          id: "e2e-md:1",
          deck: "e2e-md",
          front: "**Which city** is *this*?",
          back: "**Paris**",
          tags: ["S1", "GW01"],
          category: "World",
          meta: {
            notes: "Accept: **Lutetia**",
            explanation: "Capital of France.",
            info: [{ label: "Topic", value: "Capitals" }],
            raw: { secret: "not sent to the browser" },
          },
        },
      ],
    },
  });
  expect(res.ok()).toBeTruthy();

  await context.request.post("/api/login", { data: { passcode: PASSCODE } });
  await page.goto("/study/e2e-md");
  const card = page.locator(".card");
  await expect(card.locator("strong", { hasText: "Which city" })).toBeVisible();
  await expect(card.locator("em", { hasText: "this" })).toBeVisible();
  await expect(card.getByText("S1 · GW01")).toBeVisible();
  for (const hidden of ["Paris", "Lutetia", "Capital of France.", "Capitals", "World"]) {
    await expect(card.getByText(hidden)).toHaveCount(0);
  }

  await page.getByRole("button", { name: "Show answer" }).click();
  await expect(card.locator(".answer strong", { hasText: "Paris" })).toBeVisible();
  await expect(card.locator(".notes strong", { hasText: "Lutetia" })).toBeVisible();
  await expect(card.locator(".explanation")).toHaveText("Capital of France.");
  await expect(card.locator(".card-info")).toContainText("Topic");
  await expect(card.locator(".card-info")).toContainText("Capitals");
  await expect(card.locator(".card-info")).toContainText("World");

  const next = await (await context.request.get("/api/next?deck=e2e-md")).json();
  expect(next.card.meta.raw).toBeUndefined();
});
