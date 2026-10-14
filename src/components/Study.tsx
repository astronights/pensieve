"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { NextResult } from "@/lib/queue";
import { MediaList } from "./Media";

type Props = { deckId: string; category?: string; season?: string };

const RATINGS = [
  { value: 1, label: "Again", cls: "again" },
  { value: 2, label: "Hard", cls: "hard" },
  { value: 3, label: "Good", cls: "good" },
  { value: 4, label: "Easy", cls: "easy" },
] as const;

export default function Study({ deckId, category, season }: Props) {
  const [data, setData] = useState<NextResult | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const qs = new URLSearchParams({ deck: deckId });
    if (category) qs.set("category", category);
    if (season) qs.set("season", season);
    const res = await fetch(`/api/next?${qs}`, { cache: "no-store" });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    setData(body);
    setRevealed(false);
  }, [deckId, category, season]);

  const run = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  useEffect(() => {
    // Initial fetch; `run` only sets state after the request resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void run(load);
  }, [run, load]);

  const card = data?.card ?? null;
  const browse = data?.deck.kind === "browse" && card && !card.inReviewQueue;

  const send = useCallback(
    (body: Record<string, unknown>) =>
      run(async () => {
        if (!card) return;
        const res = await fetch("/api/review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ card_id: card.id, ...body }),
        });
        if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
        await load();
      }),
    [card, load, run],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (busy || !card) return;
      if (!revealed && (e.key === " " || e.key === "Enter")) {
        e.preventDefault();
        setRevealed(true);
      } else if (revealed && ["1", "2", "3", "4"].includes(e.key)) {
        void send({ rating: Number(e.key) });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, card, revealed, send]);

  return (
    <main>
      <header>
        <Link href="/">← Decks</Link>
        {data && (
          <span className="counts muted">
            <span className="count-due">{data.counts.due}</span>
            <span className="count-new">{data.counts.new}</span>
          </span>
        )}
      </header>

      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="muted">Loading…</p>}
      {data && !card && (
        <p className="muted">
          Nothing left in {data.deck.name} right now. <Link href="/">Back to decks</Link>
        </p>
      )}

      {card && (
        <>
          <div
            className="card"
            role="button"
            tabIndex={0}
            aria-label={revealed ? "Card" : "Reveal answer"}
            onClick={() => setRevealed(true)}
          >
            <MediaList media={card.media} side="front" />
            <div className="card-text">{card.front}</div>
            {revealed && (
              <>
                <hr />
                <MediaList media={card.media} side="back" />
                <div className="card-text">{card.back}</div>
              </>
            )}
            {(card.category || card.tags.length > 0) && (
              <p className="muted">{[card.category, ...card.tags].filter(Boolean).join(" · ")}</p>
            )}
          </div>

          {!revealed ? (
            <button className="reveal" onClick={() => setRevealed(true)} disabled={busy}>
              Show answer
            </button>
          ) : browse ? (
            <div className="actions three">
              <button className="again" disabled={busy} onClick={() => send({ rating: 1 })}>
                Again
              </button>
              <button className="hard" disabled={busy} onClick={() => send({ action: "add_to_review" })}>
                Add to review
              </button>
              <button className="good" disabled={busy} onClick={() => send({ rating: 3 })}>
                Next
              </button>
            </div>
          ) : (
            <div className="actions">
              {RATINGS.map((r) => (
                <button key={r.value} className={r.cls} disabled={busy} onClick={() => send({ rating: r.value })}>
                  {r.label}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </main>
  );
}
