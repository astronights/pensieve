import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

const PASSCODE = process.env.APP_PASSCODE ?? "";

/** A looping fake microphone: 1.5 s of quiet, then 0.7 s of "speech" (a tone), then 2 s of quiet. */
function fakeMicFile(): string {
  const rate = 16_000;
  const seconds = [1.5, 0.7, 2];
  const total = Math.round(seconds.reduce((a, b) => a + b) * rate);
  const toneFrom = seconds[0] * rate;
  const toneTo = (seconds[0] + seconds[1]) * rate;
  const buf = Buffer.alloc(44 + total * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + total * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(total * 2, 40);
  for (let i = 0; i < total; i++) {
    const v = i >= toneFrom && i < toneTo ? 0.4 * Math.sin((2 * Math.PI * 220 * i) / rate) : 0;
    buf.writeInt16LE(Math.round(v * 0x7fff), 44 + i * 2);
  }
  const file = path.join(tmpdir(), "pensieve-fake-mic.wav");
  writeFileSync(file, buf);
  return file;
}

test.use({
  permissions: ["microphone"],
  launchOptions: {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${fakeMicFile()}`,
    ],
  },
});

test("voice with Gemini: the mic stays open and each utterance is transcribed on the server", async ({
  page,
  context,
}) => {
  const res = await context.request.post("/api/import", {
    headers: { Authorization: `Bearer ${PASSCODE}` },
    data: {
      decks: [{ id: "e2e-gemini", name: "Swedish gemini", kind: "srs" }],
      cards: [
        { id: "e2e-gemini:1", deck: "e2e-gemini", front: "hej", back: "hello, hi" },
        { id: "e2e-gemini:2", deck: "e2e-gemini", front: "Which river is longest?", back: "The **Nile**" },
      ],
    },
  });
  expect(res.ok()).toBeTruthy();
  await context.request.post("/api/login", { data: { passcode: PASSCODE } });

  // Gemini chosen in Settings; the browser's recogniser must not be used.
  await page.addInitScript(() => {
    localStorage.setItem("pensieve:voice-engine", "gemini");
    localStorage.setItem("pensieve:voice-accent", "en-IN");
    const fail = function () {
      throw new Error("browser speech recognition used");
    };
    Object.assign(window, { SpeechRecognition: fail, webkitSpeechRecognition: fail });
  });
  const replies = ["hi", "the nile"];
  const requests: { mime_type: string; languages: string[]; audio: string }[] = [];
  await page.route("**/api/transcribe", async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ json: { text: replies.shift() ?? "" } });
  });

  await page.goto("/study/e2e-gemini");
  const card = page.locator(".card");
  await expect(card).toContainText("hej");
  await page.getByRole("button", { name: /^Voice off/ }).click();

  // Each "utterance" from the fake mic is sent as a WAV clip, with the user's accent and the deck's language as hints.
  await expect(card.locator(".verdict.ok")).toContainText("hi", { timeout: 10_000 });
  expect(requests[0].mime_type).toBe("audio/wav");
  expect(requests[0].languages).toEqual(["en-IN", "sv-SE"]);
  expect(Buffer.from(requests[0].audio, "base64").subarray(0, 4).toString()).toBe("RIFF");
  await expect(card).toContainText("Which river is longest?", { timeout: 5000 });

  // Still listening on the next card without restarting anything.
  await expect(card.locator(".verdict.ok")).toContainText("the nile", { timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Tap to listen" })).toHaveCount(0);
});

test("voice with Gemini: a missing key is explained", async ({ page, context }) => {
  await context.request.post("/api/login", { data: { passcode: PASSCODE } });
  await page.addInitScript(() => localStorage.setItem("pensieve:voice-engine", "gemini"));
  await page.goto("/study/e2e-gemini");
  await expect(page.locator(".card")).toBeVisible();
  await page.getByRole("button", { name: /^Voice off/ }).click();
  // CI has no GEMINI_API_KEY: the server says so and voice turns off.
  await expect(page.getByText("Gemini isn't set up")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: /^Voice off/ })).toBeVisible();
});
