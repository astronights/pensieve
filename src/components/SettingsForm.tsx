"use client";

import { useMemo, useState } from "react";
import type { Settings } from "@/lib/settings";

function timeZones(current: string): string[] {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    // Older browsers: fall back to just the current value plus UTC.
  }
  return [...new Set(["UTC", current, ...zones])];
}

export default function SettingsForm({ initial }: { initial: Settings }) {
  const [values, setValues] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [status, setStatus] = useState<{ kind: "idle" | "saving" | "saved" } | { kind: "error"; message: string }>({
    kind: "idle",
  });
  const zones = useMemo(() => timeZones(values.timezone), [values.timezone]);
  const dirty = JSON.stringify(values) !== JSON.stringify(saved);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    setStatus({ kind: "idle" });
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus({ kind: "saving" });
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setStatus({ kind: "error", message: body.error ?? `HTTP ${res.status}` });
      return;
    }
    setValues(body);
    setSaved(body);
    setStatus({ kind: "saved" });
  };

  return (
    <form className="settings" onSubmit={save}>
      <label className="field">
        <span className="field-label">New cards per day</span>
        <span className="field-help">Per spaced-repetition deck. Reviews of cards you&apos;ve already seen are never capped.</span>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          max={1000}
          step={1}
          required
          value={values.daily_new_limit}
          onChange={(e) => set("daily_new_limit", e.target.valueAsNumber)}
        />
      </label>

      <label className="field">
        <span className="field-label">
          Desired retention <output>{Math.round(values.desired_retention * 100)}%</output>
        </span>
        <span className="field-help">
          How likely you should be to remember a card when it comes up. Higher means more frequent reviews.
        </span>
        <input
          type="range"
          min={0.7}
          max={0.99}
          step={0.01}
          value={values.desired_retention}
          onChange={(e) => set("desired_retention", e.target.valueAsNumber)}
        />
      </label>

      <label className="field">
        <span className="field-label">Timezone</span>
        <span className="field-help">When &quot;today&quot; starts for the new-card limit.</span>
        <select value={values.timezone} onChange={(e) => set("timezone", e.target.value)}>
          {zones.map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="link-button"
          onClick={() => set("timezone", Intl.DateTimeFormat().resolvedOptions().timeZone)}
        >
          Use this device&apos;s timezone
        </button>
      </label>

      <button type="submit" className="primary" disabled={!dirty || status.kind === "saving"}>
        {status.kind === "saving" ? "Saving…" : "Save"}
      </button>
      {status.kind === "saved" && <p className="success">Saved.</p>}
      {status.kind === "error" && <p className="error">{status.message}</p>}
    </form>
  );
}
