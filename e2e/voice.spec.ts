import { expect, test, type Page } from "@playwright/test";

const PASSCODE = process.env.APP_PASSCODE ?? "";

/** A fake microphone and speech engine: `__say(text)` is what the user says; `__spoken` what was read. */
async function fakeSpeech(page: Page) {
  await page.addInitScript(() => {
    type Rec = { onresult?: (e: unknown) => void; onend?: () => void };
    const w = window as unknown as Record<string, unknown>;
    w.__spoken = [];
    w.__listening = null;
    class FakeRecognition {
      start() {
        w.__listening = this;
      }
      abort() {
        if (w.__listening === this) w.__listening = null;
      }
    }
    w.SpeechRecognition = FakeRecognition;
    w.webkitSpeechRecognition = FakeRecognition;
    w.__say = (text: string) => {
      const r = w.__listening as Rec | null;
      if (!r) return false;
      w.__listening = null;
      const result = Object.assign([{ transcript: text }], { isFinal: true });
      r.onresult?.({ resultIndex: 0, results: [result] });
      r.onend?.();
      return true;
    };
    Object.defineProperty(window, "speechSynthesis", {
      value: {
        speak(u: SpeechSynthesisUtterance) {
          (w.__spoken as { text: string; lang: string }[]).push({ text: u.text, lang: u.lang });
          setTimeout(() => u.onend?.(new Event("end") as SpeechSynthesisEvent), 10);
        },
        cancel() {},
        getVoices: () => [],
      },
    });
  });
}

/** Says something once the app is listening. */
async function say(page: Page, text: string) {
  await expect.poll(() => page.evaluate(() => !!(window as unknown as { __listening: unknown }).__listening)).toBe(true);
  await page.evaluate((t) => (window as unknown as { __say: (t: string) => boolean }).__say(t), text);
}

test("voice: spoken answers are checked and counted, with commands and read-aloud", async ({ page, context }) => {
  const res = await context.request.post("/api/import", {
    headers: { Authorization: `Bearer ${PASSCODE}` },
    data: {
      decks: [{ id: "e2e-voice", name: "Swedish voice", kind: "srs" }],
      cards: [
        { id: "e2e-voice:1", deck: "e2e-voice", front: "hej", back: "hello, hi" },
        { id: "e2e-voice:2", deck: "e2e-voice", front: "Which river is longest?", back: "The **Nile**" },
      ],
    },
  });
  expect(res.ok()).toBeTruthy();
  await context.request.post("/api/login", { data: { passcode: PASSCODE } });
  await fakeSpeech(page);
  await page.goto("/study/e2e-voice");
  const card = page.locator(".card");
  await expect(card).toContainText("hej");

  // Voice answers: a right answer shows ✓ and counts as Good after a moment.
  await page.getByRole("button", { name: /^Voice off/ }).click();
  await expect(page.getByRole("button", { name: /^Voice answers/ })).toBeVisible();
  await say(page, "hi");
  await expect(card.locator(".verdict.ok")).toContainText("hi");
  await expect(page.locator(".actions .good.pending")).toBeVisible();
  await expect(card).toContainText("Which river is longest?", { timeout: 5000 });

  // A wrong answer shows ✗; "right" overrules it straight away.
  await say(page, "the amazon");
  await expect(card.locator(".verdict.wrong")).toBeVisible();
  await expect(page.locator(".actions .again.pending")).toBeVisible();
  await say(page, "right");
  await expect(card).toContainText("hej");
  // "show" reveals without checking; then "good" answers.
  await say(page, "show answer");
  await expect(card).toContainText("hello, hi");
  await expect(card.locator(".verdict")).toHaveCount(0);
  await say(page, "good");
  // The river card counted as Good: one dot filled.
  await expect(card).toContainText("Which river is longest?");
  await expect(card.locator(".dot.learn.on")).toHaveCount(1);

  // Read aloud: the question in the deck's language, the answer in English.
  await page.getByRole("button", { name: /^Voice answers/ }).click();
  await expect(page.getByRole("combobox", { name: "Read questions in" })).toHaveValue("sv-SE");
  const spoken = () => page.evaluate(() => (window as unknown as { __spoken: unknown[] }).__spoken);
  await expect.poll(spoken).toContainEqual({ text: "Which river is longest?", lang: "sv-SE" });
  await say(page, "nile");
  await expect.poll(spoken).toContainEqual({ text: "Correct.", lang: "en-US" });
  await expect.poll(spoken).toContainEqual({ text: "The Nile", lang: "en-US" });

  // "stop" turns voice off.
  await expect(card).toContainText("hej", { timeout: 5000 });
  await say(page, "stop");
  await expect(page.getByRole("button", { name: /^Voice off/ })).toBeVisible();
});
