"use client";

import { useEffect, useState } from "react";
import { ACCENTS, savedAccent, VOICE_ACCENT_KEY, VOICE_ENGINE_KEY, type VoiceEngine } from "./useVoice";

const OPTIONS: { value: VoiceEngine; label: string }[] = [
  { value: "browser", label: "Browser" },
  { value: "gemini", label: "Gemini" },
];

/** Which speech recogniser voice study uses. Saved on this device, like the appearance. */
export default function VoiceEnginePicker({ geminiAvailable }: { geminiAvailable: boolean }) {
  const [engine, setEngine] = useState<VoiceEngine>("browser");
  const [accent, setAccent] = useState("en-US");

  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (localStorage.getItem(VOICE_ENGINE_KEY) === "gemini") setEngine("gemini");
      setAccent(savedAccent());
    } catch {
      // storage unavailable: stays on the default
    }
  }, []);

  const choose = (next: VoiceEngine) => {
    setEngine(next);
    try {
      if (next === "browser") localStorage.removeItem(VOICE_ENGINE_KEY);
      else localStorage.setItem(VOICE_ENGINE_KEY, next);
    } catch {
      // not remembered
    }
  };

  const chooseAccent = (code: string) => {
    setAccent(code);
    try {
      if (code === "en-US") localStorage.removeItem(VOICE_ACCENT_KEY);
      else localStorage.setItem(VOICE_ACCENT_KEY, code);
    } catch {
      // not remembered
    }
  };

  return (
    <>
      <div className="field">
        <span className="field-label">Voice recognition</span>
        <span className="field-help">
          Saved on this device. Browser uses Chrome&apos;s own recogniser (on Android it dings each time it starts
          listening). Gemini keeps the mic open and transcribes each answer on the server: no dings, better with names
          and other languages.
          {!geminiAvailable && " Needs GEMINI_API_KEY in the app's environment."}
        </span>
        <div className="segmented" role="group" aria-label="Voice recognition">
          {OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              aria-pressed={engine === o.value}
              disabled={o.value === "gemini" && !geminiAvailable && engine !== "gemini"}
              onClick={() => choose(o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <span className="field-label">Your accent</span>
        <span className="field-help">
          The English that voice answers are heard in, so your accent is understood better. Saved on this device.
        </span>
        <div className="segmented" role="group" aria-label="Your accent">
          {ACCENTS.map((a) => (
            <button key={a.code} type="button" aria-pressed={accent === a.code} onClick={() => chooseAccent(a.code)}>
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
