"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { NextResult } from "@/lib/queue";
import BackLink from "./BackLink";
import { cardExtras } from "@/lib/card-extras";
import Markdown from "./Markdown";
import { MediaList } from "./Media";
import { useVoice, voiceSupported } from "./useVoice";
import {
  answerTargets,
  checkAnswer,
  languageFromName,
  parseCommand,
  SPOKEN_LANGUAGES,
  speechParts,
  type VoiceCommand,
  type VoicePhase,
} from "@/lib/voice";

type Props = { deckId: string; category?: string; season?: string };
type Counts = NextResult["counts"];

/** Text longer than this reads better left-aligned at body size than as a big centred word. */
const LONG_TEXT = 80;

type Answer = "again" | "good";

/** Voice: off, answers by voice, or also read each card aloud. */
type VoiceMode = "off" | "listen" | "read";
const VOICE_MODES: VoiceMode[] = ["off", "listen", "read"];
const VOICE_KEY = "pensieve:voice";
const langKey = (group: string) => `pensieve:voice-lang:${group}`;
/** How long a spoken answer's ✓/✗ shows before it counts, so a misheard answer can be corrected. */
export const VERDICT_MS = 2000;

const VOICE_LABEL: Record<VoiceMode, string> = {
  off: "Voice off",
  listen: "Voice answers",
  read: "Read aloud + voice answers",
};

const storage = {
  get(key: string) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      // Private mode etc.: the choice just isn't remembered.
    }
  },
};

function VoiceIcon({ mode }: { mode: VoiceMode }) {
  const mic = (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </>
  );
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      {mode === "read" ? (
        <>
          <path d="M3 9v6h4l5 4V5L7 9H3z" />
          <path d="M16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12" />
        </>
      ) : (
        mic
      )}
      {mode === "off" && <path d="M4 4l16 16" />}
    </svg>
  );
}

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
  const [voice, setVoiceState] = useState<VoiceMode>("off");
  const [voiceOk, setVoiceOk] = useState(false);
  const [langOverride, setLangOverride] = useState<string | null>(null);
  /** What was heard as an answer to this card and whether it was right; `counting` once the 2s run. */
  const [verdict, setVerdict] = useState<{ ok: boolean; heard: string } | null>(null);
  const [counting, setCounting] = useState(false);
  const countdown = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopCountdown = useCallback(() => {
    if (countdown.current) clearTimeout(countdown.current);
    countdown.current = null;
    setCounting(false);
  }, []);

  const setVoice = useCallback(
    (mode: VoiceMode) => {
      setVoiceState(mode);
      if (mode === "off") stopCountdown();
      storage.set(VOICE_KEY, mode === "off" ? null : mode);
    },
    [stopCountdown],
  );

  useEffect(() => {
    const ok = voiceSupported();
    // Browser-only facts, read after hydration (same as the deck list's saved state).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVoiceOk(ok);
    const saved = storage.get(VOICE_KEY) as VoiceMode | null;
    if (ok && saved && VOICE_MODES.includes(saved)) setVoiceState(saved);
  }, []);

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
    setVerdict(null);
    setCounting(false);
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

  // ---- Voice ----
  const group = data?.deck.group ?? "";
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLangOverride(group ? storage.get(langKey(group)) : null);
  }, [group]);
  const frontLang = langOverride ?? languageFromName(group) ?? "en-US";
  const phase: VoicePhase = !revealed ? "question" : verdict ? "verdict" : "answer";

  const { status, speak, cancelSpeech } = useVoice({
    active: voice !== "off",
    // Kept on between cards (what's heard while an answer saves is ignored): restarting the mic
    // brings up Android's microphone notification each time.
    listen: voice !== "off" && !!card,
    onHeard: (alts) => latest.current.onHeard(alts),
    onFatal: (message) => {
      setError(message);
      setVoice("off");
    },
  });

  // A new card cancels the previous card's countdown (`show` resets `counting`).
  useEffect(
    () => () => {
      if (countdown.current) clearTimeout(countdown.current);
      countdown.current = null;
    },
    [view],
  );

  const front = useCallback(() => (card ? speechParts(card.front, frontLang) : []), [card, frontLang]);
  const back = useCallback(() => (card ? speechParts(card.back, "en-US") : []), [card]);
  const more = useCallback(
    () => [extras.notes, extras.explanation].flatMap((t) => (t ? speechParts(t, "en-US") : [])),
    [extras.notes, extras.explanation],
  );

  // Latest values for speech callbacks, which fire long after the render that set them up.
  const latest = useRef({ onHeard: (() => {}) as (alts: string[]) => void, voice, answer, verdict });
  const onHeard = (alts: string[]) => {
    if (!card || busy) return;
    const command = alts.map((a) => parseCommand(a, phase)).find(Boolean) as VoiceCommand | undefined;
    if (command === "stop") return setVoice("off");
    if (command === "repeat") return void speak(revealed ? back() : front());
    if (command === "more") return void speak(more());
    if (phase === "question") {
      cancelSpeech(); // answering while the question is read out
      if (command !== "show")
        setVerdict({ ok: checkAnswer(alts, answerTargets(card.back, extras.notes)), heard: alts[0] });
      setRevealed(true);
    } else if (command === "good" || command === "again") {
      cancelSpeech();
      stopCountdown();
      void answer(command);
    }
  };
  useLayoutEffect(() => {
    latest.current = { onHeard, voice, answer, verdict };
  });

  // Read each new card's question aloud.
  const reading = voice === "read";
  useEffect(() => {
    if (reading && !revealed) void speak(front());
    // Only when a card is shown or reading is switched on, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, reading]);

  // On reveal: read the answer (in read mode), then start the countdown on a spoken answer.
  useEffect(() => {
    if (!revealed) return;
    let cancelled = false;
    void (async () => {
      const v = latest.current.verdict;
      if (latest.current.voice === "read") {
        // A right answer was just said, so it isn't read back; a wrong one is followed by the answer.
        const parts = !v
          ? back()
          : v.ok
            ? [{ text: "Correct.", lang: "en-US" }]
            : [{ text: "Not quite.", lang: "en-US" }, ...back()];
        await speak(parts);
        // Interrupted by "repeat"/"more" still counts down; a new card cancels.
        if (cancelled) return;
      }
      if (!v || cancelled || latest.current.voice === "off") return;
      setCounting(true);
      countdown.current = setTimeout(() => {
        countdown.current = null;
        void latest.current.answer(v.ok ? "good" : "again");
      }, VERDICT_MS);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealed, view]);

  const hint =
    status === "speaking"
      ? "Reading…"
      : phase === "question"
        ? "Say the answer or “show”"
        : phase === "verdict"
          ? "“Right” or “wrong” to change"
          : "Say “good” or “again”";

  return (
    <main className="study">
      <header>
        <BackLink />
        <span className="header-actions">
          {voiceOk && (
            <button
              type="button"
              className={`icon-button voice-button${voice !== "off" ? " on" : ""}`}
              aria-label={`${VOICE_LABEL[voice]} (tap to change)`}
              title={VOICE_LABEL[voice]}
              onClick={() => setVoice(VOICE_MODES[(VOICE_MODES.indexOf(voice) + 1) % VOICE_MODES.length])}
            >
              <VoiceIcon mode={voice} />
            </button>
          )}
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
        </span>
        {voice !== "off" && (
          <div className="voice-bar" aria-live="polite">
            <span className={`voice-dot ${status}`} aria-hidden="true" />
            <span className="voice-hint">
              <strong>{voice === "read" ? "Read aloud" : "Voice"}</strong> · {hint}
            </span>
            {voice === "read" && (
              <select
                aria-label="Read questions in"
                value={frontLang}
                onChange={(e) => {
                  const lang = e.target.value;
                  const auto = languageFromName(group) ?? "en-US";
                  setLangOverride(lang === auto ? null : lang);
                  storage.set(langKey(group), lang === auto ? null : lang);
                }}
              >
                {SPOKEN_LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.name}
                  </option>
                ))}
              </select>
            )}
          </div>
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
                {verdict && (
                  <p className={`verdict ${verdict.ok ? "ok" : "wrong"}`}>
                    {verdict.ok ? "✓" : "✗"} <span className="muted">heard</span> “{verdict.heard}”
                  </p>
                )}
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
              <button
                className={`again${counting && verdict && !verdict.ok ? " pending" : ""}`}
                disabled={busy}
                onClick={() => {
                  stopCountdown();
                  void answer("again");
                }}
              >
                Again
                {outcomes && <span className="interval">{cardsLater(outcomes.again)}</span>}
              </button>
              <button
                className={`good${counting && verdict?.ok ? " pending" : ""}`}
                disabled={busy}
                onClick={() => {
                  stopCountdown();
                  void answer("good");
                }}
              >
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
