import { type Card, type Grade, State, createEmptyCard, fsrs } from "ts-fsrs";
import type { CardStage } from "@/db/schema";
import type { cardState } from "@/db/schema";

export type CardStateRow = typeof cardState.$inferSelect;

const STAGE_TO_STATE: Record<CardStage, State> = {
  new: State.New,
  learning: State.Learning,
  review: State.Review,
  relearning: State.Relearning,
};

const STATE_TO_STAGE: Record<State, CardStage> = {
  [State.New]: "new",
  [State.Learning]: "learning",
  [State.Review]: "review",
  [State.Relearning]: "relearning",
};

export function toFsrsCard(row: CardStateRow | null | undefined, now: Date): Card {
  if (!row) return createEmptyCard(now);
  return {
    due: row.due,
    stability: row.stability,
    difficulty: row.difficulty,
    elapsed_days: 0,
    scheduled_days: 0,
    learning_steps: row.learningSteps,
    reps: row.reps,
    lapses: row.lapses,
    state: STAGE_TO_STATE[row.state],
    last_review: row.lastReview ?? undefined,
  };
}

export function fromFsrsCard(card: Card) {
  return {
    due: card.due,
    stability: card.stability,
    difficulty: card.difficulty,
    state: STATE_TO_STAGE[card.state],
    reps: card.reps,
    lapses: card.lapses,
    learningSteps: card.learning_steps,
    lastReview: card.last_review ?? null,
  };
}

export function schedule(
  row: CardStateRow | null | undefined,
  rating: Grade,
  now: Date,
  desiredRetention: number,
) {
  const scheduler = fsrs({ request_retention: desiredRetention, enable_fuzz: true });
  return fromFsrsCard(scheduler.next(toFsrsCard(row, now), now, rating).card);
}
