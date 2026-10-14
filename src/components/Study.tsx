"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { NextResult } from "@/lib/queue";
import BackLink from "./BackLink";
import { cardExtras } from "@/lib/card-extras";
import { formatInterval } from "@/lib/format";
import Markdown from "./Markdown";
import { MediaList } from "./Media";

type Props = { deckId: string; category?: string; season?: string };
type Counts = NextResult["counts"];

/** Text longer than this reads better left-aligned at body size than as a big centred word. */
const LONG_TEXT = 80;

const RATINGS = [
  { value: 1, label: "Again", cls: "again" },
  { value: 2, label: "Hard", cls: "hard" },
  { value: 3, label: "Good", cls: "good" },
  { value: 4, label: "Easy", cls: "easy" },
] as const;

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as T;
}

/**
 * Study loop. To keep taps instant, the next card is prefetched while the current one is on
 * screen; answering shows it immediately and saves the answer in the background.
 */
export default function Study({ deckId, category, season }: Props) {
  const [data, setData] = useState<NextResult | null>(null);
  const [view, setView] = useState(0); // bumps on every card shown (the same card can return)
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Saves are chained so a prefetch never runs before the previous answer is stored.
  const lastSave = useRef<Promise<unknown>>(Promise.resolve());
  const prefetch = useRef<{ after: string; result: Promise<NextResult> } | null>(null);

  const fetchNext = useCallback(
    async (exclude?: string) => {
      const qs = new URLSearchParams({ deck: deckId });
      if (category) qs.set("category", category);
      if (season) qs.set("season", season);
      if (exclude) qs.set("exclude", exclude);
      return json<NextResult>(await fetch(`/api/next?${qs}`, { cache: "no-store" }));
    },
    [deckId, category, season],
  );

  const show = useCallback((next: NextResult) => {
    setData(next);
    setRevealed(false);
    setView((v) => v + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchNext().then(
      (next) => !cancelled && show(next),
      (e) => !cancelled && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [fetchNext, show]);

  const card = data?.card ?? null;
  const cardId = card?.id;

  // On reveal, bring the answer into view if it starts below the middle of the screen.
  const answerRef = useRef<HTMLHRElement>(null);
  useEffect(() => {
    const el = answerRef.current;
    if (!revealed || !el) return;
    if (el.getBoundingClientRect().top > window.innerHeight * 0.5) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [revealed, view]);

  // Prefetch the card after this one as soon as it's on screen.
  useEffect(() => {
    if (!cardId) return;
    const result = lastSave.current.then(() => fetchNext(cardId));
    result.catch(() => {}); // handled where it's used
    prefetch.current = { after: cardId, result };
  }, [cardId, view, fetchNext]);

  const answer = useCallback(
    async (body: { rating: number } | { action: "add_to_review" }) => {
      if (!card || busy) return;
      setError(null);

      const save = lastSave.current
        .catch(() => {})
        .then(async () =>
          json<{ counts?: Counts }>(
            await fetch("/api/review", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ card_id: card.id, ...body }),
            }),
          ),
        );
      lastSave.current = save;

      const pending = prefetch.current?.after === card.id ? prefetch.current.result : null;
      prefetch.current = null;

      setBusy(true);
      try {
        let next = pending ? await pending.catch(() => null) : null;
        if (next?.card) {
          // Show the prefetched card now; finish saving in the background.
          show(next);
          setBusy(false);
          save.then(
            (res) => {
              // Counts in the prefetch were computed before this answer was saved.
              if (res.counts) {
                const counts = res.counts;
                setData((d) => (d && d.card?.id === next!.card!.id ? { ...d, counts } : d));
              }
            },
            (e) => setError(`Couldn't save your last answer: ${e instanceof Error ? e.message : e}`),
          );
          return;
        }
        // Nothing else was queued: the card just answered may come straight back, so wait.
        await save;
        next = await fetchNext();
        show(next);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, card, fetchNext, show],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (busy || !card) return;
      if (!revealed && (e.key === " " || e.key === "Enter")) {
        e.preventDefault();
        setRevealed(true);
      } else if (revealed && ["1", "2", "3", "4"].includes(e.key)) {
        void answer({ rating: Number(e.key) });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, card, revealed, answer]);

  const browse = data?.deck.kind === "browse" && card && !card.inReviewQueue;
  const extras = cardExtras(card?.meta);

  return (
    <main>
      <header>
        <BackLink />
        {data && (
          <span className="counts" aria-label="due and new">
            <span className="chip count-due" title="due">{data.counts.due}</span>
            <span className="chip count-new" title={data.deck.kind === "srs" ? "new today" : "unseen"}>
              {data.counts.new}
            </span>
          </span>
        )}
      </header>

      {error && <p className="error">{error}</p>}
      {!data && !error && (
        <>
          <div className="skeleton" aria-label="Loading" style={{ flex: 1, minHeight: "50dvh", borderRadius: 16 }} />
          <div className="skeleton" style={{ height: 64 }} />
        </>
      )}
      {data && !card && (
        <p className="muted">
          Nothing left in {data.deck.name} right now. <Link href="/">Back to decks</Link>
        </p>
      )}

      {card && (
        <>
          <div
            className={revealed ? "card revealed" : "card"}
            role="button"
            tabIndex={0}
            aria-label={revealed ? "Card" : "Reveal answer"}
            onClick={() => setRevealed(true)}
          >
            <MediaList key={`f-${view}`} media={card.media} side="front" />
            <Markdown className={`card-text md${card.front.length > LONG_TEXT ? " long" : ""}`} text={card.front} />
            {card.tags.length > 0 && <p className="muted card-tags">{card.tags.join(" · ")}</p>}
            {revealed && (
              <>
                <hr ref={answerRef} />
                <Markdown className={`card-text md answer${card.back.length > LONG_TEXT ? " long" : ""}`} text={card.back} />
                {extras.notes && <Markdown className="md notes" text={extras.notes} />}
                {extras.explanation && <Markdown className="md explanation" text={extras.explanation} />}
                <MediaList key={`b-${view}`} media={card.media} side="back" />
                {(card.category || extras.info.length > 0) && (
                  <dl className="card-info">
                    {extras.info.map((line, i) => (
                      <div key={i}>
                        <dt>{line.label}</dt>
                        <dd>{line.value}</dd>
                      </div>
                    ))}
                    {card.category && (
                      <div>
                        <dt>Category</dt>
                        <dd>{card.category}</dd>
                      </div>
                    )}
                  </dl>
                )}
              </>
            )}
          </div>

          {!revealed ? (
            <button className="reveal" onClick={() => setRevealed(true)} disabled={busy}>
              Show answer
            </button>
          ) : browse ? (
            <div className="actions three">
              <button className="again" disabled={busy} onClick={() => answer({ rating: 1 })}>
                Again
                {data?.intervals && <span className="interval">{formatInterval(data.intervals[1])}</span>}
              </button>
              <button className="hard" disabled={busy} onClick={() => answer({ action: "add_to_review" })}>
                Add to review
              </button>
              <button className="good" disabled={busy} onClick={() => answer({ rating: 3 })}>
                Next
              </button>
            </div>
          ) : (
            <div className="actions">
              {RATINGS.map((r) => (
                <button key={r.value} className={r.cls} disabled={busy} onClick={() => answer({ rating: r.value })}>
                  {r.label}
                  {data?.intervals && <span className="interval">{formatInterval(data.intervals[r.value])}</span>}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </main>
  );
}
