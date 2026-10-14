import { safeNextPath } from "@/lib/auth";

export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  return (
    <main>
      <form className="stack" action="/api/login" method="post">
        <h1>Pensieve</h1>
        <input type="hidden" name="next" value={safeNextPath(next)} />
        <input
          type="password"
          name="passcode"
          placeholder="Passcode"
          autoComplete="current-password"
          autoFocus
          required
        />
        {error && <p className="error">Wrong passcode.</p>}
        <button type="submit">Enter</button>
      </form>
    </main>
  );
}
