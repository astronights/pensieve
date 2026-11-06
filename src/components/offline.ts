"use client";

/**
 * Online when possible, offline when not. The app asks the server for cards and sends it answers;
 * when the server can't be reached it uses the copy of the data on the phone (src/lib/engine.ts)
 * and queues the answers, which are sent ("synced") as soon as the server is back, in order.
 *
 * - The copy is downloaded on sync: when the app opens, when the connection returns, and with the
 *   Sync button. Cards are only downloaded again when they changed.
 * - Answers given online are applied to the copy too, so it stays current between syncs.
 * - While answers are queued, the server isn't asked for cards (it hasn't seen them yet).
 */
import { answerOffline, countsFor, listDecksOffline, nextCardOffline, searchOffline } from "@/lib/engine";
import type { Counts, DeckSummary, NextFilters, NextResult } from "@/lib/queue";
import type { SearchHit } from "@/lib/search";
import type { Snapshot, SnapshotCard } from "@/lib/snapshot";

type Queued = { card_id: string; answer: "again" | "good"; at: number };

export type SyncStatus = {
  /** The server answered the last time it was asked (and the browser thinks it's online). */
  online: boolean;
  /** Answers waiting to be sent. */
  pending: number;
  syncing: boolean;
  lastSync: number | null;
  /** A copy of the cards is on the phone. */
  ready: boolean;
  error: string | null;
};

const REQUEST_TIMEOUT_MS = 6000;
const SYNC_TIMEOUT_MS = 60_000;
/** After the server couldn't be reached, use the copy straight away for this long before retrying. */
const RETRY_AFTER_MS = 20_000;

// ---- Storage: IndexedDB (a few MB of cards is too much for localStorage) ----

const DB_NAME = "pensieve-offline";
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function kv<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest | void): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", mode);
    const req = run(tx.objectStore("kv"));
    tx.oncomplete = () => resolve((req ? req.result : undefined) as T);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const kvGet = <T>(key: string) => kv<T | undefined>("readonly", (s) => s.get(key));
const kvSet = (key: string, value: unknown) => kv<void>("readwrite", (s) => void s.put(value, key));

// ---- State ----

let snap: Snapshot | null = null;
let queue: Queued[] = [];
let lastSync: number | null = null;
let reachable = true;
let lastFailure = 0;
let syncing: Promise<void> | null = null;
let error: string | null = null;
let loaded: Promise<void> | null = null;
/** Saving to the server and changing the copy happen one at a time, in order. */
let lock: Promise<unknown> = Promise.resolve();
const listeners = new Set<(s: SyncStatus) => void>();

const browserOnline = () => typeof navigator === "undefined" || navigator.onLine !== false;
/** Worth asking the server: the browser is online and it didn't just fail. */
const tryServer = () => browserOnline() && Date.now() - lastFailure > RETRY_AFTER_MS;

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    lastFailure = 0;
    emit();
  });
  window.addEventListener("offline", () => emit());
}

export function status(): SyncStatus {
  return {
    online: browserOnline() && reachable,
    pending: queue.length,
    syncing: syncing !== null,
    lastSync,
    ready: !!snap?.cards,
    error,
  };
}

function emit() {
  const s = status();
  for (const fn of listeners) fn(s);
}

export function subscribe(fn: (s: SyncStatus) => void): () => void {
  listeners.add(fn);
  fn(status());
  return () => void listeners.delete(fn);
}

function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  lock = run.catch(() => {});
  return run;
}

/** Loads the copy saved on the phone (once). */
export function load(): Promise<void> {
  loaded ??= (async () => {
    try {
      const [meta, cards, saved, at] = await Promise.all([
        kvGet<Omit<Snapshot, "cards">>("snapshot"),
        kvGet<SnapshotCard[]>("cards"),
        kvGet<Queued[]>("queue"),
        kvGet<number>("lastSync"),
      ]);
      if (meta) snap = { ...meta, cards };
      queue = saved ?? [];
      lastSync = at ?? null;
    } catch {
      // No IndexedDB (e.g. a private window): online only.
    }
    emit();
  })();
  return loaded;
}

async function saveProgress() {
  if (!snap) return;
  const { cards, ...meta } = snap;
  void cards;
  await Promise.all([kvSet("snapshot", meta), kvSet("queue", queue)]).catch(() => {});
}

// ---- Network ----

class NetworkError extends Error {}

/** A JSON request; NetworkError when the server can't be reached (offline, timeout, server down). */
async function request<T>(url: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  if (!browserOnline()) throw new NetworkError("offline");
  const timer = AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      cache: "no-store",
      ...init,
      signal: init.signal ? AbortSignal.any([init.signal, timer]) : timer,
    });
  } catch (e) {
    // Cancelled by the caller (e.g. a newer search): not a sign of being offline.
    if (init.signal?.aborted) throw e;
    throw new NetworkError(e instanceof Error ? e.message : String(e));
  }
  if (res.status === 502 || res.status === 503 || res.status === 504) throw new NetworkError(`HTTP ${res.status}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

function setReachable(ok: boolean) {
  lastFailure = ok ? 0 : Date.now();
  if (reachable !== ok) {
    reachable = ok;
    emit();
  }
}

const NOT_DOWNLOADED = "You're offline and the cards haven't been downloaded to this phone yet. Connect once to sync.";

// ---- Studying ----

/** The next card: from the server when it can be reached and has every answer, else from the copy. */
export async function fetchNext(deckId: string, filters: NextFilters): Promise<NextResult> {
  await load();
  if (queue.length > 0 && tryServer()) await sync().catch(() => {});
  if (queue.length === 0 && (tryServer() || !snap?.cards)) {
    const qs = new URLSearchParams({ deck: deckId });
    if (filters.category) qs.set("category", filters.category);
    if (filters.season) qs.set("season", filters.season);
    if (filters.exclude) qs.set("exclude", filters.exclude);
    try {
      const next = await request<NextResult>(`/api/next?${qs}`);
      setReachable(true);
      return next;
    } catch (e) {
      if (!(e instanceof NetworkError)) throw e;
      setReachable(false);
    }
  }
  if (!snap?.cards) throw new Error(NOT_DOWNLOADED);
  return nextCardOffline(snap, deckId, filters);
}

/** Saves an answer: to the server when possible (and to the copy), else to the copy and the queue. */
export function sendAnswer(cardId: string, answer: "again" | "good", deckId: string): Promise<{ counts?: Counts }> {
  return exclusive(async () => {
    await load();
    const at = Date.now();
    if (queue.length === 0 && (tryServer() || !snap?.cards)) {
      try {
        const res = await request<{ counts?: Counts }>("/api/review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ card_id: cardId, answer, deck: deckId, at }),
        });
        setReachable(true);
        if (snap?.cards) {
          try {
            answerOffline(snap, cardId, answer);
            await saveProgress();
          } catch {
            // The copy doesn't have this card yet: the next sync brings it.
          }
        }
        return res;
      } catch (e) {
        if (!(e instanceof NetworkError)) throw e;
        setReachable(false);
        // It may have reached the server even so: the server skips it when it's synced again.
      }
    }
    if (!snap?.cards) throw new Error(NOT_DOWNLOADED);
    answerOffline(snap, cardId, answer);
    queue.push({ card_id: cardId, answer, at });
    await saveProgress();
    emit();
    return { counts: countsFor(snap, deckId) };
  });
}

// ---- Sync ----

/** Sends queued answers, then downloads a fresh copy. One at a time; resolves when done. */
export function sync(): Promise<void> {
  syncing ??= exclusive(async () => {
    emit();
    try {
      await load();
      if (queue.length > 0) {
        const batch = queue.slice();
        await request(
          "/api/sync",
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answers: batch }) },
          SYNC_TIMEOUT_MS,
        );
        queue = queue.slice(batch.length);
        await kvSet("queue", queue).catch(() => {});
      }
      const have = snap?.cards ? snap.cardsVersion : "";
      const fresh = await request<Snapshot>(`/api/sync?have=${encodeURIComponent(have)}`, {}, SYNC_TIMEOUT_MS);
      const cardsChanged = !!fresh.cards;
      if (!fresh.cards) fresh.cards = snap?.cards;
      snap = fresh;
      lastSync = Date.now();
      await Promise.all([
        saveProgress(),
        cardsChanged ? kvSet("cards", fresh.cards) : undefined,
        kvSet("lastSync", lastSync),
      ]).catch(() => {});
      error = null;
      setReachable(true);
      savePagesForOffline(fresh);
    } catch (e) {
      if (e instanceof NetworkError) setReachable(false);
      else error = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }).finally(() => {
    syncing = null;
    emit();
  });
  return syncing;
}

/** Asks the service worker to save every deck's study page, so they open offline. */
function savePagesForOffline(s: Snapshot) {
  const sw = typeof navigator !== "undefined" ? navigator.serviceWorker?.controller : null;
  if (!sw) return;
  const urls = ["/", "/search", ...s.decks.map((d) => `/study/${encodeURIComponent(d.id)}`)];
  // Once a day is plenty, unless the decks changed.
  const key = urls.join("|");
  try {
    const saved = JSON.parse(localStorage.getItem("pensieve:offline-pages") ?? "{}");
    if (saved.key === key && Date.now() - saved.at < 86_400_000) return;
    localStorage.setItem("pensieve:offline-pages", JSON.stringify({ key, at: Date.now() }));
  } catch {
    // no storage: just save them
  }
  sw.postMessage({ type: "cache", urls });
}

// ---- Deck list and search ----

/** Deck counts from the copy, when it's more up to date than the server's page (offline or queued). */
export function offlineDecks(): DeckSummary[] | null {
  const s = status();
  return snap?.cards && (!s.online || s.pending > 0) ? listDecksOffline(snap) : null;
}

export async function search(q: string, signal: AbortSignal): Promise<{ total: number; cards: SearchHit[] }> {
  await load();
  if ((queue.length === 0 && tryServer()) || !snap?.cards) {
    try {
      const res = await request<{ total: number; cards: SearchHit[] }>(`/api/search?q=${encodeURIComponent(q)}`, {
        signal,
      });
      setReachable(true);
      return res;
    } catch (e) {
      if (!(e instanceof NetworkError) || !snap?.cards) throw e instanceof NetworkError ? new Error(NOT_DOWNLOADED) : e;
      setReachable(false);
    }
  }
  return searchOffline(snap, q);
}
