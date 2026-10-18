"use client";

import { useState } from "react";
import type { Settings } from "@/lib/settings";

const FIELDS: { key: keyof Settings; label: string; help: string; min: number; max: number }[] = [
  {
    key: "again_gap",
    label: "Again: back after",
    help: "How many other cards you see before a missed card comes back.",
    min: 1,
    max: 100,
  },
  {
    key: "good_gap",
    label: "Good: back after",
    help: "How many cards before a card you got right comes back. Doubles with each Good in a row.",
    min: 1,
    max: 500,
  },
  {
    key: "learned_after",
    label: "Learned after",
    help: "Goods in a row before a card counts as learned and stops showing. Again resets the count.",
    min: 1,
    max: 10,
  },
  {
    key: "review_gap",
    label: "Missed cards: first review after",
    help: "A card you've ever missed needs that many Goods in a row again before it's learned. The first comes this many cards later, then the gap doubles.",
    min: 1,
    max: 1000,
  },
];

export default function SettingsForm({ initial }: { initial: Settings }) {
  const [values, setValues] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [status, setStatus] = useState<{ kind: "idle" | "saving" | "saved" } | { kind: "error"; message: string }>({
    kind: "idle",
  });
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
      {FIELDS.map((f) => (
        <label key={f.key} className="field">
          <span className="field-label">
            {f.label}
            <span className="field-value">
              {values[f.key]} {f.key === "learned_after" ? "in a row" : "cards"}
            </span>
          </span>
          <span className="field-help">{f.help}</span>
          <input
            type="number"
            inputMode="numeric"
            min={f.min}
            max={f.max}
            step={1}
            required
            value={Number.isNaN(values[f.key]) ? "" : values[f.key]}
            onChange={(e) => set(f.key, e.target.valueAsNumber)}
          />
        </label>
      ))}

      <button type="submit" className="primary" disabled={!dirty || status.kind === "saving"}>
        {status.kind === "saving" ? "Saving…" : "Save"}
      </button>
      {status.kind === "saved" && <p className="success">Saved.</p>}
      {status.kind === "error" && <p className="error">{status.message}</p>}
    </form>
  );
}
