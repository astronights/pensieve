import Link from "next/link";
import { connection } from "next/server";
import DeckList from "@/components/DeckList";
import SyncButton from "@/components/SyncButton";
import { getDb } from "@/db";
import { listDecks } from "@/lib/queue";

export default async function Home() {
  await connection();
  const decks = await listDecks(getDb());
  return (
    <main>
      <header>
        <h1>Pensieve</h1>
        <nav className="header-actions">
          <SyncButton />
          <Link href="/search" className="icon-button" aria-label="Search" title="Search cards">
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
              <path d="M16 16l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </Link>
          <Link href="/settings" className="icon-button" aria-label="Settings" title="Settings">
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <path
                d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7.4-2.1.1-1.4-.1-1.4 2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2.4-1.4L14.2 2h-4.4l-.4 2.7A7.6 7.6 0 0 0 7 6.1l-2.4-1-2 3.4 2 1.6-.1 1.4.1 1.4-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 2.4 1.4l.4 2.7h4.4l.4-2.7a7.6 7.6 0 0 0 2.4-1.4l2.4 1 2-3.4-2-1.6Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
            </svg>
          </Link>
          <form action="/api/logout" method="post">
            <button type="submit" className="icon-button" aria-label="Log out" title="Log out">
              <svg
                viewBox="0 0 24 24"
                width="22"
                height="22"
                aria-hidden="true"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 8l-4 4 4 4M6 12h10" />
              </svg>
            </button>
          </form>
        </nav>
      </header>
      {decks.length === 0 ? (
        <p className="muted">No decks yet. Run the seed script or POST to /api/import.</p>
      ) : (
        <DeckList decks={decks} />
      )}
    </main>
  );
}
