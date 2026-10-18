"use client";

import { downsample, encodeWav, toBase64, UtteranceDetector } from "@/lib/audio";

const TARGET_RATE = 16_000;
const FRAME = 2048;

export const geminiSupported = () =>
  typeof window !== "undefined" &&
  !!navigator.mediaDevices?.getUserMedia &&
  typeof AudioContext !== "undefined" &&
  typeof AudioContext.prototype.createScriptProcessor === "function";

export type GeminiListenerEvents = {
  /** An utterance was transcribed. `capturedAt` is when the speaker stopped. */
  onText: (text: string, capturedAt: number) => void;
  /** Waiting for a transcript (true) or not. */
  onBusy: (busy: boolean) => void;
  onFatal: (message: string) => void;
  /** Language hints for the transcriber, read when each clip is sent. */
  languages: () => string[];
};

/**
 * Keeps the microphone open for the whole session (one Android notification, no dings), cuts the
 * audio into utterances when the speaker pauses, and has the server transcribe each with Gemini.
 */
export class GeminiListener {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private detector: UtteranceDetector | null = null;
  private opening: Promise<void> | null = null;
  private inFlight = 0;
  private failures = 0;
  private closed = false;

  constructor(private readonly events: GeminiListenerEvents) {}

  get open() {
    return this.stream !== null;
  }

  start(): Promise<void> {
    this.closed = false;
    if (this.stream) return Promise.resolve();
    this.opening ??= this.openMic().finally(() => (this.opening = null));
    return this.opening;
  }

  private async openMic() {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch {
      this.events.onFatal("Microphone access was blocked. Allow it in the browser's site settings.");
      return;
    }
    if (this.closed) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);
    // ScriptProcessor is old but simple and works everywhere; frames are ~43 ms at 48 kHz.
    const processor = ctx.createScriptProcessor(FRAME, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(processor);
    processor.connect(mute);
    mute.connect(ctx.destination);
    const detector = new UtteranceDetector(ctx.sampleRate);
    processor.onaudioprocess = (e) => {
      const clip = detector.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      if (clip) void this.send(clip, ctx.sampleRate, Date.now());
    };
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});
    // Without a recent tap (e.g. voice was restored on a page reload) audio stays paused until one.
    if (ctx.state === "suspended") {
      const resume = () => void ctx.resume().catch(() => {});
      document.addEventListener("pointerdown", resume, { once: true, capture: true });
    }
    this.stream = stream;
    this.ctx = ctx;
    this.detector = detector;
  }

  private async send(samples: Float32Array, rate: number, capturedAt: number) {
    const audio = toBase64(encodeWav(downsample(samples, rate, TARGET_RATE), Math.min(rate, TARGET_RATE)));
    this.events.onBusy(++this.inFlight > 0);
    try {
      const res = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio, mime_type: "audio/wav", languages: this.events.languages() }),
      });
      const body = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
      if (!res.ok) throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { status: res.status });
      this.failures = 0;
      if (!this.closed && body.text) this.events.onText(body.text, capturedAt);
    } catch (e) {
      const status = (e as { status?: number }).status;
      // Not set up, or logged out: no point retrying. Otherwise give up after a few failures in a row.
      if (status === 503 || status === 401 || ++this.failures >= 3) {
        this.events.onFatal(e instanceof Error ? e.message : String(e));
      }
    } finally {
      this.events.onBusy(--this.inFlight > 0);
    }
  }

  stop() {
    this.closed = true;
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close().catch(() => {});
    this.stream = null;
    this.ctx = null;
    this.detector = null;
  }
}
