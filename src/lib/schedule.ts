/**
 * The scheduling rules (pure, no database), shared by the server and the offline copy of the app on
 * the phone so both pick and move cards exactly the same way.
 */

export type Settings = {
  /** Again: the card comes back after this many other cards. */
  again_gap: number;
  /** Good: the card comes back after this many cards, doubling with each Good in a row. */
  good_gap: number;
  /** Goods in a row that mark a card as learned; learned cards aren't shown again. */
  learned_after: number;
  /**
   * A card that was ever missed (Again) then needs `learned_after` more Goods in a row, each this
   * many cards apart, before it is learned.
   */
  review_gap: number;
};

export const DEFAULT_SETTINGS: Settings = {
  again_gap: 5,
  good_gap: 15,
  learned_after: 3,
  review_gap: 50,
};

/** Goods in a row a card needs to be learned: twice as many once it has been missed. */
export function goodsNeeded(s: Settings, missed: boolean): number {
  return missed ? 2 * s.learned_after : s.learned_after;
}

/** A card in its review stage: missed once, then got the usual Goods in a row. */
export function inReview(s: Settings, streak: number, missed: boolean): boolean {
  return missed && streak >= s.learned_after;
}

/**
 * What Again does: the card's new streak and how many cards later it comes back. In the review
 * stage it stays there (back after `review_gap`, its review Goods restart); otherwise it starts over.
 */
export function afterAgain(s: Settings, streak: number, missed: boolean): { streak: number; gap: number } {
  return inReview(s, streak, missed) ? { streak: s.learned_after, gap: s.review_gap } : { streak: 0, gap: s.again_gap };
}

/**
 * What a Good that brings the streak to `streak` does: "learned", or how many cards later the card
 * comes back. Learning Goods double the gap (15, 30, …); a missed card's review Goods start
 * `review_gap` apart and double too (50, 100, 200).
 */
export function afterGood(s: Settings, streak: number, missed: boolean): number | "learned" {
  if (streak >= goodsNeeded(s, missed)) return "learned";
  // Review Goods double the gap too: 50, 100, 200, …
  if (streak >= s.learned_after) return s.review_gap * 2 ** (streak - s.learned_after);
  return s.good_gap * 2 ** Math.max(0, streak - 1);
}

/** While several cards are due at once, every MIX_EVERY-th card shown is a new one (if any remain). */
export const MIX_EVERY = 3;
