"use client";

import { useState } from "react";
import { THEME_COOKIE, type Theme } from "@/lib/theme";

const OPTIONS: { value: Theme; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") {
    delete root.dataset.theme;
    document.cookie = `${THEME_COOKIE}=; path=/; max-age=0; samesite=lax`;
  } else {
    root.dataset.theme = theme;
    document.cookie = `${THEME_COOKIE}=${theme}; path=/; max-age=31536000; samesite=lax`;
  }
}

/** Applies instantly and is remembered on this device (cookie), separate from the synced settings. */
export default function ThemePicker({ initial }: { initial: Theme }) {
  const [theme, setTheme] = useState(initial);

  const choose = (next: Theme) => {
    setTheme(next);
    applyTheme(next);
  };

  return (
    <div className="field">
      <span className="field-label">Appearance</span>
      <span className="field-help">Saved on this device. System follows your phone&apos;s light/dark setting.</span>
      <div className="segmented" role="group" aria-label="Appearance">
        {OPTIONS.map((o) => (
          <button key={o.value} type="button" aria-pressed={theme === o.value} onClick={() => choose(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
