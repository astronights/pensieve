"use client";

import { useEffect, useState } from "react";
import type { SearchHit } from "@/lib/search";
import Markdown from "./Markdown";

const STATUS: Record<SearchHit["status"], { cls: string; label: string }> = {
  learned: { cls: "learned", label: "Learned" },
  learning: { cls: "learning", label: "In progress" },
  new: { cls: "unseen", label: "Unseen" },
};

type Results = { query: string; total: number; cards: SearchHit[] };

/** Search box over every card; results update as you type and the query is kept in the URL. */
export default function Search({ initial }: { initial: string }) {
  const [query, setQuery] = useState(initial);
  const [results, setResults] = useState<Results | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const q = query.trim();
    // Keep the search in the address, so going back or reloading shows it again.
    const url = q ? `/search?q=${encodeURIComponent(q)}` : "/search";
    window.history.replaceState(window.history.state, "", url);
    if (!q) return;
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctrl.signal, cache: "no-store" });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        setResults({ query: q, ...body });
        setError(null);
      } catch (e) {
        if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [query]);

  const shown = query.trim() ? results : null;

  return (
    <div className="search">
      <input
        type="search"
        className="search-input"
        placeholder="Words to find…"
        aria-label="Search cards"
        value={query}
        autoFocus
        enterKeyHint="search"
        onChange={(e) => setQuery(e.target.value)}
      />
      {error && <p className="error">{error}</p>}
      {!shown ? (
        <p className="muted">
          Finds cards with all of your words in the question, answer, notes, category or tags. Put a phrase in
          &quot;quotes&quot; to keep it together.
        </p>
      ) : (
        <>
          <p className="muted search-count" aria-live="polite">
            {shown.total === 0
              ? "No cards have all of those words."
              : shown.total > shown.cards.length
                ? `Showing ${shown.cards.length} of ${shown.total} cards. Add a word to narrow it down.`
                : `${shown.total} card${shown.total === 1 ? "" : "s"}`}
          </p>
          <ul className="search-results">
            {shown.cards.map((c) => (
              <li key={c.id} className="search-hit">
                <div className="search-where">
                  <span className="muted">
                    {c.deckName}
                    {c.category && !c.deckName.endsWith(c.category) && ` · ${c.category}`}
                  </span>
                  <span className={`pill ${STATUS[c.status].cls}`}>{STATUS[c.status].label}</span>
                </div>
                <Markdown className="md search-front" text={c.front} />
                <Markdown className="md search-back" text={c.back} />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
