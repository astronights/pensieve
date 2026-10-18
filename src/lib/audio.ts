/**
 * Microphone audio → short spoken clips, for transcription. Pure (no browser APIs) so it can be
 * tested: feed it frames of samples and it hands back each utterance once the speaker pauses.
 */

export const rms = (frame: Float32Array) => {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / (frame.length || 1));
};

export type UtteranceOptions = {
  /** Audio kept from just before speech starts, so the first syllable isn't cut. */
  preRollMs: number;
  /** Quiet this long ends an utterance. */
  endSilenceMs: number;
  /** Shorter bursts (a cough, a tap) are dropped. */
  minSpeechMs: number;
  /** Long speech is cut here and sent anyway. */
  maxMs: number;
  /** Speech must be this many times louder than the background noise… */
  noiseRatio: number;
  /** …and at least this loud. */
  minLevel: number;
  /** The first this-many ms only measure the background noise. */
  calibrateMs: number;
};

export const UTTERANCE_DEFAULTS: UtteranceOptions = {
  preRollMs: 300,
  endSilenceMs: 800,
  minSpeechMs: 250,
  maxMs: 10_000,
  noiseRatio: 3,
  minLevel: 0.012,
  calibrateMs: 400,
};

/**
 * Splits a stream of audio frames into utterances with a simple energy-based voice detector. The
 * background noise level is learned while nobody is speaking.
 */
export class UtteranceDetector {
  private readonly o: UtteranceOptions;
  private noise = 0;
  private preRoll: Float32Array[] = [];
  private preRollMs = 0;
  private speech: Float32Array[] = [];
  private speechMs = 0;
  private voicedMs = 0;
  private quietMs = 0;
  private loudFrames = 0;
  private elapsedMs = 0;

  constructor(
    private readonly sampleRate: number,
    options: Partial<UtteranceOptions> = {},
  ) {
    this.o = { ...UTTERANCE_DEFAULTS, ...options };
  }

  get speaking() {
    return this.speech.length > 0;
  }

  private threshold() {
    return Math.max(this.o.minLevel, this.noise * this.o.noiseRatio);
  }

  /** Adds one frame; returns a finished utterance's samples, or null. */
  push(frame: Float32Array): Float32Array | null {
    const ms = (frame.length / this.sampleRate) * 1000;
    const level = rms(frame);
    if (this.elapsedMs < this.o.calibrateMs) {
      // Average level over the first moments, so steady background noise is never taken for speech.
      this.noise = (this.noise * this.elapsedMs + level * ms) / (this.elapsedMs + ms);
      this.elapsedMs += ms;
      return null;
    }
    const loud = level > this.threshold();

    if (!this.speaking) {
      // Learn the background level from quiet frames (slowly, so speech doesn't raise it).
      if (!loud) this.noise = this.noise * 0.95 + level * 0.05;
      this.loudFrames = loud ? this.loudFrames + 1 : 0;
      this.preRoll.push(frame);
      this.preRollMs += ms;
      while (this.preRollMs - (this.preRoll[0].length / this.sampleRate) * 1000 >= this.o.preRollMs) {
        this.preRollMs -= (this.preRoll.shift()!.length / this.sampleRate) * 1000;
      }
      // Two loud frames in a row start an utterance (one is often a click).
      if (this.loudFrames < 2) return null;
      this.speech = this.preRoll;
      this.speechMs = this.preRollMs;
      this.voicedMs = ms * 2;
      this.quietMs = 0;
      this.preRoll = [];
      this.preRollMs = 0;
      return null;
    }

    this.speech.push(frame);
    this.speechMs += ms;
    if (loud) {
      this.voicedMs += ms;
      this.quietMs = 0;
    } else {
      this.quietMs += ms;
    }
    if (this.quietMs < this.o.endSilenceMs && this.speechMs < this.o.maxMs) return null;

    const done = this.voicedMs >= this.o.minSpeechMs ? concat(this.speech) : null;
    this.reset();
    return done;
  }

  /** Drops anything half-heard (e.g. while the app itself was talking). */
  reset() {
    this.speech = [];
    this.speechMs = 0;
    this.voicedMs = 0;
    this.quietMs = 0;
    this.loudFrames = 0;
  }
}

function concat(frames: Float32Array[]): Float32Array {
  const out = new Float32Array(frames.reduce((n, f) => n + f.length, 0));
  let at = 0;
  for (const f of frames) {
    out.set(f, at);
    at += f.length;
  }
  return out;
}

/** Averages samples down to a lower rate (16 kHz is plenty for speech and keeps uploads small). */
export function downsample(samples: Float32Array, from: number, to: number): Float32Array {
  if (to >= from) return samples;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += samples[j];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

/** 16-bit mono PCM WAV. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const data = samples.length * 2;
  const buf = new ArrayBuffer(44 + data);
  const v = new DataView(buf);
  const text = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  v.setUint32(4, 36 + data, true);
  text(8, "WAVE");
  text(12, "fmt ");
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // bytes per second
  v.setUint16(32, 2, true); // bytes per frame
  v.setUint16(34, 16, true); // bits per sample
  text(36, "data");
  v.setUint32(40, data, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
