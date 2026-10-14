"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { DeckSummary } from "@/lib/queue";

const STORAGE_KEY = "pensieve:expanded-decks";

function DeckLink({ deck, subCount }: { deck: DeckSummary; subCount?: number }) {
  const kind = deck.kind === "srs" ? "spaced repetition" : "browse";
  return (
    <Link href={`/study/${encodeURIComponent(deck.id)}`} className="deck-link">
      <span>
        {deck.name}
        <br />
        <span className="muted">
          {deck.parent ? null : kind}
          {subCount ? `${deck.parent ? "" : " · "}${subCount} sub-deck${subCount === 1 ? "" : "s"}` : null}
        </span>
      </span>
      <span className="counts">
        <span className="count-due" title="due">{deck.due}</span>
        <span className="count-new" title={deck.kind === "srs" ? "new today" : "unseen"}>
          {deck.new}
        </span>
      </span>
    </Link>
  );
}

export default function DeckList({ decks }: { decks: DeckSummary[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Remember which parents are open on this device (best effort).
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (Array.isArray(saved)) setExpanded(new Set(saved.filter((x) => typeof x === "string")));
    } catch {
      // ignore unavailable or corrupt storage
    }
  }, []);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        // ignore
      }
      return next;
    });

  const children = new Map<string, DeckSummary[]>();
  for (const d of decks) {
    if (d.parent) children.set(d.parent, [...(children.get(d.parent) ?? []), d]);
  }
  const topLevel = decks.filter((d) => !d.parent);
  const anyNested = children.size > 0;

  return (
    <ul className="deck-list">
      {topLevel.map((deck) => {
        const subs = children.get(deck.id) ?? [];
        const open = expanded.has(deck.id);
        return (
          <li key={deck.id} className="deck-group">
            <div className="deck-row">
              {subs.length === 0 && anyNested && <span className="expand-spacer" aria-hidden="true" />}
              {subs.length > 0 && (
                <button
                  type="button"
                  className="expand"
                  aria-expanded={open}
                  aria-label={`${open ? "Hide" : "Show"} sub-decks of ${deck.name}`}
                  onClick={() => toggle(deck.id)}
                >
                  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                    <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              )}
              <DeckLink deck={deck} subCount={subs.length} />
            </div>
            {open && subs.length > 0 && (
              <ul className="sub-decks">
                {subs.map((sub) => (
                  <li key={sub.id}>
                    <DeckLink deck={sub} />
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}
