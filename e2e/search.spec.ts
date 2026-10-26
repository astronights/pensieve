import { expect, test } from "@playwright/test";

const PASSCODE = process.env.APP_PASSCODE ?? "";

test("search finds cards with all the keywords, across decks", async ({ page, context }) => {
  await context.request.post("/api/login", { data: { passcode: PASSCODE } });
  await page.goto("/");
  await page.getByRole("link", { name: "Search" }).click();
  await expect(page).toHaveURL(/\/search$/);

  const box = page.getByRole("searchbox", { name: "Search cards" });
  await box.fill("thank");
  const hits = page.locator(".search-hit");
  await expect(hits).toHaveCount(1);
  await expect(hits.first()).toContainText("gracias");
  await expect(hits.first()).toContainText("Spanish (demo) › Basics");
  await expect(hits.first().locator(".pill")).toHaveText("Unseen");
  await expect(page).toHaveURL(/\/search\?q=thank$/);

  // Every word must match; a reload keeps the search.
  await box.fill("thank nothing-like-this");
  await expect(page.getByText("No cards have all of those words.")).toBeVisible();
  await box.fill("planet red");
  await expect(hits).toHaveCount(1);
  await expect(hits.first()).toContainText("Mars");
  await page.reload();
  await expect(page.getByRole("searchbox", { name: "Search cards" })).toHaveValue("planet red");
  await expect(hits.first()).toContainText("Mars");
});
