"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { type SpeechPart, stripEcho, words } from "@/lib/voice";
import { GeminiListener, geminiSupported } from "./geminiListener";

// The Web Speech API isn't in TypeScript's DOM types; this is the part we use.
type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult:
    | ((e: {
        resultIndex: number;
        results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
      }) => void)
    | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  abort(): void;
};
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Which speech recogniser to use: the browser's own, or Gemini through the app's server. */
export type VoiceEngine = "browser" | "gemini";
export const VOICE_ENGINE_KEY = "pensieve:voice-engine";

/** The user's English, for recognising their accent (both engines). */
export const ACCENTS = [
  { code: "en-US", label: "US" },
  { code: "en-GB", label: "UK" },
  { code: "en-IN", label: "India" },
] as const;
export const VOICE_ACCENT_KEY = "pensieve:voice-accent";
export const savedAccent = (): string => {
  try {
    const saved = localStorage.getItem(VOICE_ACCENT_KEY);
    return ACCENTS.some((a) => a.code === saved) ? saved! : "en-US";
  } catch {
    return "en-US";
  }
};

export const voiceSupported = (engine: VoiceEngine) =>
  engine === "gemini" ? geminiSupported() : recognitionCtor() !== null;

/** `thinking`: waiting for Gemini's transcript. */
export type VoiceStatus = "idle" | "listening" | "thinking" | "speaking";

/** Browser engine: how many times listening restarts by itself after a silence before it waits for a tap. */
const SILENT_RESTARTS = 1;

/** The best installed voice for a language: exact match, then same language, then none (browser default). */
function voiceFor(lang: string): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis?.getVoices() ?? [];
  const base = lang.split("-")[0].toLowerCase();
  return (
    voices.find((v) => v.lang.replace("_", "-").toLowerCase() === lang.toLowerCase()) ??
    voices.find((v) => v.lang.toLowerCase().startsWith(base))
  );
}

/** Speaks one line; resolves when done, or after a generous estimate if the browser never says so. */
function speakOne(part: SpeechPart): Promise<void> {
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(part.text);
    u.lang = part.lang;
    const voice = voiceFor(part.lang);
    if (voice) u.voice = voice;
    const timer = setTimeout(resolve, 3000 + part.text.length * 150);
    u.onend = u.onerror = () => {
      clearTimeout(timer);
      resolve();
    };
    window.speechSynthesis.speak(u);
  });
}

/**
 * Listens for speech while `listen` is true, and reads text aloud with `speak`. The browser engine
 * listens from `listenNow` until a silence ends it (Chrome on Android dings on every start); the
 * Gemini engine keeps the mic open and sends each utterance to the server to transcribe. The microphone stays on while speaking so you can interrupt; what it hears of
 * its own voice is ignored. Keeps the screen awake while `active`.
 */
export function useVoice({
  active,
  listen,
  engine,
  languages,
  accepting = true,
  onHeard,
  onFatal,
}: {
  active: boolean;
  listen: boolean;
  /** False while what's heard would be ignored anyway, so Gemini isn't asked to transcribe it. */
  accepting?: boolean;
  engine: VoiceEngine;
  /** Language hints: the user's English first (the browser engine listens in that one), then the deck's. */
  languages: string[];
  onHeard: (alternatives: string[]) => void;
  onFatal: (message: string) => void;
}) {
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const rec = useRef<Recognition | null>(null);
  const speaking = useRef(false);
  const want = useRef(listen);
  const errors = useRef(0);
  const restart = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speech = useRef(0); // bumps to cancel what is being read
  /** Words being read aloud, until shortly after: the mic hears them too and they aren't the user. */
  const echo = useRef({ words: new Set<string>(), until: 0 });
  const handlers = useRef({ onHeard, onFatal, engine, languages, accepting });
  useLayoutEffect(() => {
    handlers.current = { onHeard, onFatal, engine, languages, accepting };
  });
  const thinking = useRef(false);
  /** Silences in a row since the user last spoke or tapped (each restart after one dings). */
  const silences = useRef(0);
  const gemini = useRef<GeminiListener | null>(null);

  const refresh = useCallback(() => {
    const open = handlers.current.engine === "gemini" ? !!gemini.current?.open : rec.current !== null;
    setStatus(speaking.current ? "speaking" : thinking.current ? "thinking" : open ? "listening" : "idle");
  }, []);

  /** Passes on what the user said, minus the app's own voice if it was reading aloud at `at`. */
  const heardSomething = useCallback((alternatives: string[], at: number) => {
    const { words: spoken, until } = echo.current;
    const own = alternatives
      .map((a) => (at <= until ? stripEcho(a, spoken) : a.trim()))
      .filter((a) => words(a).length > 0);
    if (own.length) handlers.current.onHeard(own);
  }, []);
  // `start` restarts itself from recognition events; this lets it refer to itself.
  const startRef = useRef(() => {});

  const start = useCallback(() => {
    if (restart.current) clearTimeout(restart.current);
    restart.current = null;
    if (!want.current || document.hidden) return;
    if (handlers.current.engine === "gemini") {
      gemini.current ??= new GeminiListener({
        onText: (text, at) => heardSomething([text], at),
        onBusy: (busy) => {
          thinking.current = busy;
          refresh();
        },
        onFatal: (message) => {
          want.current = false;
          gemini.current?.stop();
          handlers.current.onFatal(message);
          refresh();
        },
        languages: () => handlers.current.languages,
        accepting: () => handlers.current.accepting,
      });
      void gemini.current.start().then(refresh);
      return;
    }
    const Ctor = recognitionCtor();
    if (!Ctor || rec.current) return;
    const r = new Ctor();
    r.lang = handlers.current.languages[0] ?? "en-US";
    // One long session: every restart makes Android show its microphone notification again.
    r.continuous = true;
    r.interimResults = false;
    r.maxAlternatives = 5;
    let handled = 0; // results of this session already passed on
    let heard = false; // the session ended after hearing something, not after a silence
    let previous = ""; // Android repeats earlier phrases at the start of later ones in a session
    r.onresult = (e) => {
      // Normally results only grow, but Chrome on Android can restart the list (resultIndex back to
      // 0) within a session; trust resultIndex then, so later phrases aren't skipped.
      const from =
        e.resultIndex < handled && e.results.length <= handled ? e.resultIndex : Math.max(handled, e.resultIndex);
      for (let i = from; i < e.results.length; i++) {
        const result = e.results[i];
        if (!result?.isFinal) break;
        handled = i + 1;
        heard = true;
        errors.current = 0;
        const alts = Array.from(result, (a) => {
          const t = a.transcript.trim();
          return previous && t.length > previous.length && t.toLowerCase().startsWith(previous.toLowerCase())
            ? t.slice(previous.length).trim()
            : t;
        }).filter(Boolean);
        previous = result[0]?.transcript.trim() ?? previous;
        heardSomething(alts, Date.now());
      }
    };
    r.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        want.current = false;
        handlers.current.onFatal("Microphone access was blocked. Allow it in the browser's site settings.");
      } else if (e.error !== "no-speech" && e.error !== "aborted") {
        errors.current++;
      }
    };
    r.onend = () => {
      if (rec.current === r) rec.current = null;
      if (errors.current >= 5) {
        want.current = false;
        handlers.current.onFatal("Voice recognition isn't working (it needs an internet connection).");
        return refresh();
      }
      // Chrome on Android ends a session after each phrase and after a few seconds of silence, and
      // every new session plays a ding. Listen again after a phrase (an answer or command was just
      // given), and after the first silence, but then wait for a tap (`listenNow`).
      if (!want.current) return refresh();
      // (Restarting keeps the status as it was, so the mic button doesn't flash up in between.)
      if (heard) silences.current = 0;
      else if (silences.current++ >= SILENT_RESTARTS) return refresh();
      restart.current = setTimeout(() => startRef.current(), 150);
    };
    rec.current = r;
    try {
      r.start();
      refresh();
    } catch {
      rec.current = null;
    }
  }, [heardSomething, refresh]);

  useLayoutEffect(() => {
    startRef.current = start;
  }, [start]);

  const stop = useCallback(() => {
    if (restart.current) clearTimeout(restart.current);
    restart.current = null;
    const r = rec.current;
    rec.current = null;
    if (r) {
      r.onend = null;
      r.abort();
    }
    gemini.current?.stop();
    refresh();
  }, [refresh]);

  useEffect(() => {
    want.current = listen;
    // Starting/stopping the recogniser is the external system this effect syncs with.
    if (listen) start();
    else stop();
  }, [listen, start, stop]);

  // Switching engine: close the old one and start the new one.
  useEffect(() => {
    if (!want.current) return;
    stop();
    start();
  }, [engine, start, stop]);

  useEffect(() => {
    const onVisible = () => (document.hidden ? stop() : start());
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [start, stop]);

  const finishSpeaking = useCallback(() => {
    speaking.current = false;
    echo.current.until = Date.now() + 1500;
    refresh();
  }, [refresh]);

  /** Reads the parts in order; resolves true when finished, false if cancelled. */
  const speak = useCallback(
    async (parts: SpeechPart[]): Promise<boolean> => {
      if (!("speechSynthesis" in window) || parts.length === 0) return true;
      const id = ++speech.current;
      window.speechSynthesis.cancel();
      speaking.current = true;
      echo.current = { words: new Set(parts.flatMap((p) => words(p.text))), until: Infinity };
      setStatus("speaking");
      for (const part of parts) {
        if (speech.current !== id) return false;
        await speakOne(part);
      }
      if (speech.current !== id) return false;
      finishSpeaking();
      return true;
    },
    [finishSpeaking],
  );

  /** Stops reading aloud (when the user interrupts). */
  const cancelSpeech = useCallback(() => {
    if (!speaking.current) return;
    speech.current++;
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    finishSpeaking();
  }, [finishSpeaking]);

  // Stop everything when voice is switched off or the page goes away.
  useEffect(() => {
    if (active) return;
    speech.current++;
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
    speaking.current = false;
  }, [active]);
  useEffect(
    () => () => {
      want.current = false;
      speech.current++;
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
      stop();
    },
    [stop],
  );

  // Keep the screen on while voice is on.
  useEffect(() => {
    if (!active || !("wakeLock" in navigator)) return;
    let lock: { release(): Promise<void> } | null = null;
    let cancelled = false;
    const acquire = async () => {
      if (document.hidden) return;
      try {
        const l = await (
          navigator as unknown as {
            wakeLock: {
              request(t: "screen"): Promise<{ release(): Promise<void> }>;
            };
          }
        ).wakeLock.request("screen");
        if (cancelled) void l.release();
        else lock = l;
      } catch {
        // Not allowed (e.g. battery saver); the screen just times out as usual.
      }
    };
    void acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", acquire);
      void lock?.release();
    };
  }, [active]);

  /** Starts listening if voice is on and it isn't already (a new card, or "Tap to listen"). */
  const listenNow = useCallback(() => {
    silences.current = 0;
    start();
  }, [start]);

  return { status, speak, cancelSpeech, listenNow };
}
