"use client";

import { useEffect, useState } from "react";
import { VOICE_ENGINE_KEY, type VoiceEngine } from "./useVoice";

const OPTIONS: { value: VoiceEngine; label: string }[] = [
  { value: "browser", label: "Browser" },
  { value: "gemini", label: "Gemini" },
];

/** Which speech recogniser voice study uses. Saved on this device, like the appearance. */
export default function VoiceEnginePicker({ geminiAvailable }: { geminiAvailable: boolean }) {
  const [engine, setEngine] = useState<VoiceEngine>("browser");

  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (localStorage.getItem(VOICE_ENGINE_KEY) === "gemini") setEngine("gemini");
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

  return (
    <div className="field">
      <span className="field-label">Voice recognition</span>
      <span className="field-help">
        Saved on this device. Browser uses Chrome&apos;s own recogniser (on Android it dings each time it starts
        listening). Gemini keeps the mic open and transcribes each answer on the server: no dings, better with
        names and other languages.
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
  );
}
