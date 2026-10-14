import Link from "next/link";

export default function BackLink({ href = "/", label = "Decks" }: { href?: string; label?: string }) {
  return (
    <Link href={href} className="back">
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path d="M15 18l-6-6 6-6" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {label}
    </Link>
  );
}
