"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { DeckSummary } from "@/lib/queue";

const STORAGE_KEY = "pensieve:expanded-decks";

function Counts({ deck }: { deck: DeckSummary }) {
  if (deck.total > 0 && deck.learned === deck.total) {
    return <span className="pill done">Learned ✓</span>;
  }
  return (
    <span className="counts">
      <span className={`pill learned${deck.learned ? "" : " zero"}`} title="learned">
        {deck.learned}
      </span>
      <span className={`pill learning${deck.learning ? "" : " zero"}`} title="in progress">
        {deck.learning}
      </span>
      <span className={`pill unseen${deck.new ? "" : " zero"}`} title="unseen">
        {deck.new}
      </span>
    </span>
  );
}

/** "3 decks · 576 cards" */
function subtitle(deck: DeckSummary, subDecks: number): string {
  const parts = [];
  if (subDecks > 0) parts.push(`${subDecks} deck${subDecks === 1 ? "" : "s"}`);
  parts.push(`${deck.total} card${deck.total === 1 ? "" : "s"}`);
  return parts.join(" · ");
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
    <>
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
                      <span className="deck-sub muted">{subtitle(deck, subs.length)}</span>
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
                        <path
                          d="M6 9l6 6 6-6"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.25"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                  )}
                </div>
                {open && (
                  <ul className="deck-children">
                    {subs.map((sub) => (
                      <li key={sub.id}>
                        <Link href={studyHref(sub.id)} className="deck-child">
                          <span className="deck-title">
                            <span className="deck-name">{sub.name}</span>
                            <span className="deck-sub muted">{subtitle(sub, 0)}</span>
                          </span>
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
      <p className="legend muted">
        <span className="legend-item learned">learned</span>
        <span className="legend-item learning">in progress</span>
        <span className="legend-item unseen">unseen</span>
      </p>
    </>
  );
}
