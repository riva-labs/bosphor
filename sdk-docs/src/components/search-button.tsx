'use client';

import { Search } from 'lucide-react';
import { useSearchContext } from 'fumadocs-ui/contexts/search';

/** A large "Search the docs" button that opens the site search dialog. */
export function SearchButton({ label = 'Search the docs' }: { label?: string }) {
  const { setOpenSearch } = useSearchContext();
  return (
    <button
      type="button"
      onClick={() => setOpenSearch(true)}
      className="inline-flex w-full max-w-md items-center gap-3 rounded-xl border bg-fd-card px-4 py-3 text-left text-sm text-fd-muted-foreground transition-colors hover:bg-fd-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring"
    >
      <Search className="size-4 shrink-0" aria-hidden />
      <span className="flex-1">{label}</span>
      <kbd className="rounded border bg-fd-secondary px-1.5 py-px font-mono text-[11px]">Ctrl K</kbd>
    </button>
  );
}
