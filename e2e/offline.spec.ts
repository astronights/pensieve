import { expect, test } from "@playwright/test";

const PASSCODE = process.env.APP_PASSCODE ?? "";
const auth = { Authorization: `Bearer ${PASSCODE}` };

test("offline: study from the copy on the phone, then sync the answers", async ({ page, context }) => {
  const imported = await context.request.post("/api/import", {
    headers: auth,
    data: {
      decks: [{ id: "e2e-offline", name: "Offline deck", kind: "srs" }],
      cards: ["one", "two", "three", "four", "five"].map((w, i) => ({
        id: `e2e-offline:${i}`,
        deck: "e2e-offline",
        front: `front ${w}`,
        back: `back ${w}`,
      })),
    },
  });
  expect(imported.ok()).toBeTruthy();
  await context.request.post("/api/login", { data: { passcode: PASSCODE } });

  // Online: the app installs its service worker and downloads the copy.
  await page.goto("/");
  await page.waitForFunction(async () => !!(await navigator.serviceWorker?.ready));
  await page.reload(); // now controlled by the service worker
  const sync = page.locator(".sync-button");
  await expect(sync).toHaveAttribute("aria-label", /Synced/);
  await sync.click(); // saves every deck's page for offline
  await expect(sync).toHaveAttribute("aria-label", /Synced/);
  await expect
    .poll(() => page.evaluate(async () => !!(await caches.match("/study/e2e-offline"))), { timeout: 15_000 })
    .toBe(true);
  await expect.poll(() => page.evaluate(async () => !!(await caches.match("/search")))).toBe(true);

  // Offline: the saved page opens and cards come from the copy.
  await context.setOffline(true);
  await page.goto("/study/e2e-offline");
  await expect(page.locator(".chip.offline")).toBeVisible();
  for (const w of ["one", "two", "three"]) {
    await expect(page.locator(".card")).toContainText(`front ${w}`);
    await page.getByRole("button", { name: "Show answer" }).click();
    await page.getByRole("button", { name: /^Good/ }).click();
  }
  await expect(page.locator(".card")).toContainText("front four");
  await expect(page.locator(".chip.learning")).toHaveText("3");

  // The deck list counts from the copy and shows the answers waiting to be sent.
  await page.goto("/");
  const deck = page.locator(".deck-card", { hasText: "Offline deck" });
  await expect(deck.locator(".pill.learning")).toHaveText("3");
  await expect(sync.locator(".sync-badge")).toHaveText("3");
  await expect(sync).toHaveAttribute("aria-label", /Offline · 3 answers to sync/);

  // Search works offline too.
  await page.goto("/search?q=front%20two");
  await expect(page.locator(".search-hit")).toHaveCount(1);
  await expect(page.locator(".search-hit .pill")).toHaveText("In progress");

  // Back online: the answers are sent by themselves, once.
  await context.setOffline(false);
  await page.goto("/");
  await expect(sync).toHaveAttribute("aria-label", /Synced/, { timeout: 15_000 });
  await expect(sync.locator(".sync-badge")).toHaveCount(0);
  const decks = await (await context.request.get("/api/decks", { headers: auth })).json();
  const saved = decks.decks.find((d: { id: string }) => d.id === "e2e-offline");
  expect(saved).toMatchObject({ learning: 3, new: 2 });
  // And studying continues from where it left off, now from the server.
  await page.goto("/study/e2e-offline");
  await expect(page.locator(".card")).toContainText("front four");
  await expect(page.locator(".chip.offline")).toHaveCount(0);
});
