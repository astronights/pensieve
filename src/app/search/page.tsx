import BackLink from "@/components/BackLink";
import Search from "@/components/Search";

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  const { q } = await searchParams;
  return (
    <main>
      <header>
        <BackLink />
      </header>
      <h1>Search</h1>
      <Search initial={typeof q === "string" ? q : ""} />
    </main>
  );
}
