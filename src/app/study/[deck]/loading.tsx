import BackLink from "@/components/BackLink";

/** Instant placeholder for the study screen while the first card loads. */
export default function Loading() {
  return (
    <main aria-busy="true" aria-label="Loading">
      <header>
        <BackLink />
      </header>
      <div className="skeleton" style={{ flex: 1, minHeight: "50dvh", borderRadius: 16 }} />
      <div className="skeleton" style={{ height: 64 }} />
    </main>
  );
}
