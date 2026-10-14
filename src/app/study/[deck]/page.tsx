import Study from "@/components/Study";

export default async function StudyPage({
  params,
  searchParams,
}: {
  params: Promise<{ deck: string }>;
  searchParams: Promise<{ category?: string; season?: string }>;
}) {
  const { deck } = await params;
  const { category, season } = await searchParams;
  return <Study deckId={decodeURIComponent(deck)} category={category} season={season} />;
}
