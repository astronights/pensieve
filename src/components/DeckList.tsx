"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { DeckSummary } from "@/lib/queue";

const STORAGE_KEY = "pensieve:expanded-decks";

function Counts({ deck }: { deck: DeckSummary }) {
  return (
    <span className="counts">
      <span className={`pill due${deck.due ? "" : " zero"}`} title="due for review">
        {deck.due}
      </span>
      <span className={`pill new${deck.new ? "" : " zero"}`} title={deck.kind === "srs" ? "new today" : "unseen"}>
        {deck.new}
      </span>
    </span>
  );
}

const studyHref = (id: string) => `/study/${encodeURIComponent(id)}`;

export default function DeckList({ decks }: { decks: DeckSummary[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Remember which decks are open on this device (best effort).
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

  return (
    <ul className="deck-list">
      {decks
        .filter((d) => !d.parent)
        .map((deck) => {
          const subs = children.get(deck.id) ?? [];
          const open = subs.length > 0 && expanded.has(deck.id);
          return (
            <li key={deck.id} className={`deck-card${open ? " open" : ""}`}>
              <div className="deck-head">
                <Link href={studyHref(deck.id)} className="deck-main">
                  <span className="deck-title">
                    <span className="deck-name">
                      {deck.name}
                      {deck.kind === "browse" && <span className="tag">Browse</span>}
                    </span>
                    {subs.length > 0 && (
                      <span className="deck-sub muted">
                        {subs.length} deck{subs.length === 1 ? "" : "s"}
                      </span>
                    )}
                  </span>
                  <Counts deck={deck} />
                </Link>
                {subs.length > 0 && (
                  <button
                    type="button"
                    className="deck-toggle"
                    aria-expanded={open}
                    aria-label={`${open ? "Hide" : "Show"} decks in ${deck.name}`}
                    onClick={() => toggle(deck.id)}
                  >
                    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                      <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                )}
              </div>
              {open && (
                <ul className="deck-children">
                  {subs.map((sub) => (
                    <li key={sub.id}>
                      <Link href={studyHref(sub.id)} className="deck-child">
                        <span className="deck-name">{sub.name}</span>
                        <Counts deck={sub} />
                      </Link>
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
