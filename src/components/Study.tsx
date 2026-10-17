"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { NextResult } from "@/lib/queue";
import BackLink from "./BackLink";
import { cardExtras } from "@/lib/card-extras";
import Markdown from "./Markdown";
import { MediaList } from "./Media";

type Props = { deckId: string; category?: string; season?: string };
type Counts = NextResult["counts"];

/** Text longer than this reads better left-aligned at body size than as a big centred word. */
const LONG_TEXT = 80;

type Answer = "again" | "good";

const cardsLater = (n: number) => `${n} card${n === 1 ? "" : "s"} later`;

/**
 * Goods in a row so far: green dots for learning, then (for a card that was missed) blue dots for
 * its review Goods, set a little apart.
 */
function Streak({ streak, needed, learnedAfter }: NonNullable<NextResult["outcomes"]>) {
  const dots = (from: number, to: number, cls: string) =>
    Array.from({ length: to - from }, (_, i) => (
      <span key={from + i} className={`dot ${cls}${from + i < streak ? " on" : ""}`} />
    ));
  const reviewing = needed > learnedAfter;
  const label =
    reviewing && streak >= learnedAfter
      ? `Review: ${streak - learnedAfter} of ${needed - learnedAfter} in a row`
      : `${Math.min(streak, learnedAfter)} of ${learnedAfter} in a row`;
  return (
    <span className="streak" role="img" aria-label={label} title={label}>
      <span className="dots">{dots(0, learnedAfter, "learn")}</span>
      {reviewing && <span className="dots">{dots(learnedAfter, needed, "review")}</span>}
    </span>
  );
}

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
    async (choice: Answer) => {
      if (!card || busy) return;
      setError(null);

      const save = lastSave.current
        .catch(() => {})
        .then(async () =>
          json<{ counts?: Counts }>(
            await fetch("/api/review", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ card_id: card.id, answer: choice, deck: deckId }),
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
    [busy, card, deckId, fetchNext, show],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (busy || !card) return;
      if (!revealed && (e.key === " " || e.key === "Enter")) {
        e.preventDefault();
        setRevealed(true);
      } else if (revealed && e.key === "1") {
        void answer("again");
      } else if (revealed && (e.key === "2" || e.key === " " || e.key === "Enter")) {
        e.preventDefault();
        void answer("good");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, card, revealed, answer]);

  const browse = data?.deck.kind === "browse" && card && !card.learning;
  const outcomes = data?.outcomes;
  const extras = cardExtras(card?.meta);

  return (
    <main>
      <header>
        <BackLink />
        {data && (
          <span className="counts" aria-label="learned, in progress and unseen">
            <span className="chip learned" title="learned">
              {data.counts.learned}
            </span>
            <span className="chip learning" title="in progress">
              {data.counts.learning}
            </span>
            <span className="chip unseen" title="unseen">
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
          {data.counts.total > 0 && data.counts.learned === data.counts.total
            ? `You've learned every card in ${data.deck.name}.`
            : `Nothing left in ${data.deck.name}.`}{" "}
          <Link href="/">Back to decks</Link>
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
            {outcomes && !browse && <Streak {...outcomes} />}
            <MediaList key={`f-${view}`} media={card.media} side="front" />
            <Markdown className={`card-text md${card.front.length > LONG_TEXT ? " long" : ""}`} text={card.front} />
            {card.tags.length > 0 && <p className="muted card-tags">{card.tags.join(" · ")}</p>}
            {revealed && (
              <>
                <hr ref={answerRef} />
                <Markdown
                  className={`card-text md answer${card.back.length > LONG_TEXT ? " long" : ""}`}
                  text={card.back}
                />
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
          ) : (
            <div className="actions two">
              <button className="again" disabled={busy} onClick={() => answer("again")}>
                Again
                {outcomes && <span className="interval">{cardsLater(outcomes.again)}</span>}
              </button>
              <button className="good" disabled={busy} onClick={() => answer("good")}>
                {browse ? "Next" : "Good"}
                {outcomes && !browse && (
                  <span className="interval">
                    {outcomes.good === "learned" ? "Learned ✓" : cardsLater(outcomes.good)}
                  </span>
                )}
              </button>
            </div>
          )}
        </>
      )}
    </main>
  );
}
