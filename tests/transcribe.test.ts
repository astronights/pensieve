import { afterEach, describe, expect, it, vi } from "vitest";
import { downsample, encodeWav, UtteranceDetector } from "@/lib/audio";
import { HttpError } from "@/lib/errors";
import { geminiRequest, parseTranscribeInput, transcribe, transcriptFrom } from "@/lib/transcribe";

describe("Gemini transcription", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("validates the request from the browser", () => {
    expect(
      parseTranscribeInput({ audio: "AAA", mime_type: "audio/wav", languages: ["en-US", "sv-SE", "x y"] }),
    ).toEqual({ audio: "AAA", mime_type: "audio/wav", languages: ["en-US", "sv-SE"] });
    expect(parseTranscribeInput({ audio: "AAA", mime_type: "audio/webm;codecs=opus" }).mime_type).toBe("audio/webm");
    expect(() => parseTranscribeInput({})).toThrow("audio");
    expect(() => parseTranscribeInput({ audio: "AAA", mime_type: "video/mp4" })).toThrow("Unsupported");
    expect(() => parseTranscribeInput({ audio: "A".repeat(3_000_000) })).toThrow("too long");
  });

  it("asks for a verbatim transcript of inline audio, not stored", () => {
    expect(geminiRequest({ audio: "AAA", mime_type: "audio/wav", languages: ["en-US"] })).toEqual({
      model: "gemini-3.5-transcribe",
      input: [{ type: "audio", data: "AAA", mime_type: "audio/wav" }],
      generation_config: { transcription_config: { mode: { type: "verbatim" }, language_codes: ["en-US"] } },
      store: false,
    });
  });

  it("reads the transcript from the model's output steps", () => {
    expect(
      transcriptFrom({
        steps: [
          { type: "user_input", content: [{ type: "audio" }] },
          { type: "model_output", content: [{ type: "text", text: " The Nile. " }] },
        ],
      }),
    ).toBe("The Nile.");
    expect(transcriptFrom({ output_text: "hej" })).toBe("hej");
    expect(transcriptFrom({})).toBe("");
  });

  it("calls the Interactions API with the key and returns the text", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    const fetchImpl = vi.fn(async () =>
      Response.json({ steps: [{ type: "model_output", content: [{ type: "text", text: "show" }] }] }),
    );
    const text = await transcribe({ audio: "AAA", mime_type: "audio/wav", languages: [] }, fetchImpl);
    expect(text).toBe("show");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("test-key");
    expect(JSON.parse(init.body as string).model).toBe("gemini-3.5-transcribe");
  });

  it("explains a missing key (503) and Gemini errors (502)", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    await expect(transcribe({ audio: "A", mime_type: "audio/wav", languages: [] })).rejects.toMatchObject({
      status: 503,
    });
    vi.stubEnv("GEMINI_API_KEY", "bad");
    const fetchImpl = vi.fn(async () => Response.json({ error: { message: "API key not valid" } }, { status: 400 }));
    const err = await transcribe({ audio: "A", mime_type: "audio/wav", languages: [] }, fetchImpl).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 502, message: expect.stringContaining("API key not valid") });
  });
});

describe("cutting mic audio into utterances", () => {
  const RATE = 16_000;
  const FRAME = 640; // 40 ms
  const frame = (level: number) => Float32Array.from({ length: FRAME }, (_, i) => (i % 2 ? level : -level));
  const feed = (d: UtteranceDetector, level: number, ms: number) => {
    const clips: Float32Array[] = [];
    for (let t = 0; t < ms; t += 40) {
      const clip = d.push(frame(level));
      if (clip) clips.push(clip);
    }
    return clips;
  };

  it("returns one clip per phrase once the speaker pauses, with a bit of audio from before", () => {
    const d = new UtteranceDetector(RATE);
    expect(feed(d, 0.002, 1000)).toEqual([]); // background noise
    expect(feed(d, 0.2, 600)).toEqual([]); // speaking
    const clips = feed(d, 0.002, 1200); // pause
    expect(clips).toHaveLength(1);
    const ms = (clips[0].length / RATE) * 1000;
    expect(ms).toBeGreaterThanOrEqual(600 + 280); // speech + pre-roll
    expect(ms).toBeLessThan(600 + 300 + 900); // + the pause that ended it
  });

  it("ignores short clicks and adapts to a noisy room", () => {
    const d = new UtteranceDetector(RATE);
    expect(feed(d, 0.002, 500)).toEqual([]);
    expect(feed(d, 0.3, 40)).toEqual([]); // one loud frame: a click
    expect(feed(d, 0.002, 1000)).toEqual([]);
    const noisy = new UtteranceDetector(RATE);
    expect(feed(noisy, 0.03, 3000)).toEqual([]); // steady fan noise isn't speech
    feed(noisy, 0.3, 500);
    expect(feed(noisy, 0.03, 1200)).toHaveLength(1);
  });

  it("cuts very long speech", () => {
    const d = new UtteranceDetector(RATE, { maxMs: 2000 });
    feed(d, 0.002, 400);
    expect(feed(d, 0.2, 3000).length).toBeGreaterThanOrEqual(1);
  });

  it("encodes 16 kHz mono WAV", () => {
    const samples = downsample(new Float32Array(48_000).fill(0.5), 48_000, 16_000);
    expect(samples.length).toBe(16_000);
    const wav = encodeWav(samples, 16_000);
    const v = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe("RIFF");
    expect(v.getUint32(24, true)).toBe(16_000);
    expect(v.getUint32(40, true)).toBe(32_000);
    expect(wav.length).toBe(44 + 32_000);
  });
});
