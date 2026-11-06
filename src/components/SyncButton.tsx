"use client";

import { useEffect, useState } from "react";
import * as offline from "./offline";

function ago(t: number): string {
  const min = Math.round((Date.now() - t) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

/**
 * Sync status and button: sends answers given offline and downloads the latest cards. The badge
 * counts answers waiting to be sent.
 */
export default function SyncButton() {
  const [s, setS] = useState<offline.SyncStatus | null>(null);
  useEffect(() => offline.subscribe(setS), []);
  if (!s) return null;

  const label = s.syncing
    ? "Syncing…"
    : !s.online
      ? `Offline${s.pending ? ` · ${s.pending} answer${s.pending === 1 ? "" : "s"} to sync` : ""}`
      : s.error
        ? `Sync failed: ${s.error}`
        : s.pending
          ? `${s.pending} answer${s.pending === 1 ? "" : "s"} to sync`
          : s.lastSync
            ? `Synced ${ago(s.lastSync)}`
            : "Not synced yet";

  return (
    <button
      type="button"
      className={`icon-button sync-button${s.syncing ? " syncing" : ""}${s.online ? "" : " offline"}`}
      aria-label={`Sync (${label})`}
      title={label}
      onClick={() => offline.sync().catch(() => {})}
    >
      <svg
        viewBox="0 0 24 24"
        width="22"
        height="22"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {s.online ? (
          <>
            <path className="sync-arrows" d="M20 12a8 8 0 0 1-14.3 4.9M4 12A8 8 0 0 1 18.3 7.1" />
            <path d="M18.5 3v4.3h-4.3M5.5 21v-4.3h4.3" />
          </>
        ) : (
          <>
            <path d="M7 18h10a4 4 0 0 0 .7-7.9A6 6 0 0 0 6.2 9.6 4.3 4.3 0 0 0 7 18Z" />
            <path d="M4 4l16 16" />
          </>
        )}
      </svg>
      {s.pending > 0 && <span className="sync-badge">{s.pending > 99 ? "99+" : s.pending}</span>}
    </button>
  );
}
