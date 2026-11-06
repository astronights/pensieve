import type { DeckKind, MediaItem } from "@/db/schema";
import type { Settings } from "./schedule";

/** The offline copy of the app's data (see sync.ts for how it's built, engine.ts for how it's used). */
export type SnapshotDeck = { id: string; name: string; kind: DeckKind; parent: string | null; answers: number };

export type SnapshotCard = {
  id: string;
  deck: string;
  front: string;
  back: string;
  tags: string[];
  category: string | null;
  media: MediaItem[];
  meta: Record<string, unknown> | null;
  /** Position in import order (created_at, then id), as the database sorts it. */
  order: number;
  /** Position when sorted by id, as the database sorts it (ties between due cards). */
  idRank: number;
};

export type SnapshotState = {
  streak: number;
  dueAt: number | null;
  seen: boolean;
  learned: boolean;
  missed: boolean;
  bookmarked: boolean;
};

export type Snapshot = {
  /** Changes whenever cards are added or changed; the phone sends it back so unchanged cards aren't resent. */
  cardsVersion: string;
  settings: Settings;
  decks: SnapshotDeck[];
  states: Record<string, SnapshotState>;
  /** Left out when the phone already has this version of the cards. */
  cards?: SnapshotCard[];
};
