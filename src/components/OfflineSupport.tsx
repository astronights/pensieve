"use client";

import { useEffect } from "react";
import * as offline from "./offline";

/** How stale the copy on the phone may get before the app refreshes it by itself. */
const RESYNC_AFTER_MS = 5 * 60_000;

/**
 * Makes the app work offline: registers the service worker (which saves the app's pages and code)
 * and keeps the copy of the cards fresh — on opening, when the connection comes back and when the
 * app returns to the foreground after a while.
 */
export default function OfflineSupport() {
  useEffect(() => {
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
    const quiet = () => offline.sync().catch(() => {});
    void offline.load().then(quiet);
    const onVisible = () => {
      const { lastSync } = offline.status();
      if (!document.hidden && (!lastSync || Date.now() - lastSync > RESYNC_AFTER_MS)) quiet();
    };
    window.addEventListener("online", quiet);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", quiet);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return null;
}
