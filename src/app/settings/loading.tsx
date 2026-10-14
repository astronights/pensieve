import BackLink from "@/components/BackLink";

/** Instant placeholder for settings while its values load. */
export default function Loading() {
  return (
    <main aria-busy="true" aria-label="Loading">
      <header>
        <BackLink />
      </header>
      <h1>Settings</h1>
      <div className="skeleton" style={{ height: 120 }} />
      <div className="skeleton" style={{ height: 130 }} />
      <div className="skeleton" style={{ height: 150 }} />
    </main>
  );
}
