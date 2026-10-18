"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { type SpeechPart, words } from "@/lib/voice";

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

export const voiceSupported = () => recognitionCtor() !== null;

export type VoiceStatus = "idle" | "listening" | "speaking";

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

/** Mostly words that are being (or were just) read aloud. */
function isEcho({ words: spoken, until }: { words: Set<string>; until: number }, heard: string): boolean {
  if (Date.now() > until) return false;
  const w = words(heard);
  return w.length === 0 || w.filter((x) => spoken.has(x)).length / w.length >= 0.6;
}

/**
 * Listens for speech (English) in one long session while `listen` is true, and reads text
 * aloud with `speak`. The microphone stays on while speaking so you can interrupt; what it hears of
 * its own voice is ignored. Keeps the screen awake while `active`.
 */
export function useVoice({
  active,
  listen,
  onHeard,
  onFatal,
}: {
  active: boolean;
  listen: boolean;
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
  const handlers = useRef({ onHeard, onFatal });
  useLayoutEffect(() => {
    handlers.current = { onHeard, onFatal };
  });
  // `start` restarts itself from recognition events; this lets it refer to itself.
  const startRef = useRef(() => {});

  const start = useCallback(() => {
    if (restart.current) clearTimeout(restart.current);
    restart.current = null;
    const Ctor = recognitionCtor();
    if (!Ctor || !want.current || rec.current || document.hidden) return;
    const r = new Ctor();
    r.lang = "en-US";
    // One long session: every restart makes Android show its microphone notification again.
    r.continuous = true;
    r.interimResults = false;
    r.maxAlternatives = 5;
    let handled = 0; // results of this session already passed on
    let previous = ""; // Android repeats earlier phrases at the start of later ones in a session
    r.onresult = (e) => {
      for (let i = Math.max(handled, e.resultIndex); i < e.results.length; i++) {
        const result = e.results[i];
        if (!result?.isFinal) break;
        handled = i + 1;
        errors.current = 0;
        const alts = Array.from(result, (a) => {
          const t = a.transcript.trim();
          return previous && t.length > previous.length && t.toLowerCase().startsWith(previous.toLowerCase())
            ? t.slice(previous.length).trim()
            : t;
        }).filter(Boolean);
        previous = result[0]?.transcript.trim() ?? previous;
        if (alts.length && !isEcho(echo.current, alts[0])) handlers.current.onHeard(alts);
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
      setStatus(speaking.current ? "speaking" : "idle");
      if (errors.current >= 5) {
        want.current = false;
        handlers.current.onFatal("Voice recognition isn't working (it needs an internet connection).");
        return;
      }
      // Recognition can still stop after a long silence; start again (slower after errors).
      if (want.current) restart.current = setTimeout(() => startRef.current(), 150 + errors.current * 1000);
    };
    rec.current = r;
    try {
      r.start();
      if (!speaking.current) setStatus("listening");
    } catch {
      rec.current = null;
    }
  }, []);

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
    setStatus(speaking.current ? "speaking" : "idle");
  }, []);

  useEffect(() => {
    want.current = listen;
    // Starting/stopping the recogniser is the external system this effect syncs with.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (listen) start();
    else stop();
  }, [listen, start, stop]);

  useEffect(() => {
    const onVisible = () => (document.hidden ? stop() : start());
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [start, stop]);

  const finishSpeaking = useCallback(() => {
    speaking.current = false;
    echo.current.until = Date.now() + 1500;
    setStatus(rec.current ? "listening" : "idle");
  }, []);

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

  return { status, speak, cancelSpeech };
}
