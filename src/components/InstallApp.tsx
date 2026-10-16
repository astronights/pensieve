"use client";

import { useEffect, useState } from "react";

/** Chrome's install event (not yet in TypeScript's DOM types). */
type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

/** Offers "Install app" where the browser allows it (Chrome on Android, desktop Chrome/Edge). */
export default function InstallApp() {
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInstalled(window.matchMedia("(display-mode: standalone)").matches);
    const onPrompt = (e: Event) => {
      e.preventDefault(); // show our button instead of Chrome's mini-infobar
      setPrompt(e as InstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setPrompt(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (installed) return null;

  return (
    <div className="field">
      <span className="field-label">App</span>
      {prompt ? (
        <>
          <span className="field-help">Add Pensieve to your home screen; it opens full screen like an app.</span>
          <button
            type="button"
            className="primary"
            onClick={async () => {
              await prompt.prompt();
              await prompt.userChoice;
              setPrompt(null);
            }}
          >
            Install app
          </button>
        </>
      ) : (
        <span className="field-help">
          To install, open this site in Chrome and choose <strong>⋮ → Add to Home screen</strong> (or Install app).
        </span>
      )}
    </div>
  );
}
