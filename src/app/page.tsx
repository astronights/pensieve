import Link from "next/link";
import { connection } from "next/server";
import { getDb } from "@/db";
import { listDecks } from "@/lib/queue";

export default async function Home() {
  await connection();
  const decks = await listDecks(getDb());
  return (
    <main>
      <header>
        <h1>Pensieve</h1>
        <form action="/api/logout" method="post">
          <button type="submit">Log out</button>
        </form>
      </header>
      {decks.length === 0 ? (
        <p className="muted">No decks yet. Run the seed script or POST to /api/import.</p>
      ) : (
        <ul className="deck-list">
          {decks.map((d) => (
            <li key={d.id}>
              <Link href={`/study/${encodeURIComponent(d.id)}`}>
                <span>
                  {d.name}
                  <br />
                  <span className="muted">{d.kind === "srs" ? "spaced repetition" : "browse"}</span>
                </span>
                <span className="counts">
                  <span className="count-due" title="due">{d.due}</span>
                  <span className="count-new" title={d.kind === "srs" ? "new today" : "unseen"}>
                    {d.new}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
