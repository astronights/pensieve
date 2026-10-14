/** Instant placeholder for the deck list while it loads. */
export default function Loading() {
  return (
    <main aria-busy="true" aria-label="Loading">
      <header>
        <h1>Pensieve</h1>
      </header>
      <div className="skeleton" style={{ height: 76 }} />
      <div className="skeleton" style={{ height: 76 }} />
    </main>
  );
}
