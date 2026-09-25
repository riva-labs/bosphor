'use client';

import dynamic from 'next/dynamic';

// Code-split the playground so only the playground page downloads it. The chain
// libraries inside are split again and load on the first quote or wallet action.
export const Playground = dynamic(() => import('./playground').then((m) => m.Playground), {
  loading: () => (
    <div className="not-prose my-6 h-96 animate-pulse rounded-xl border bg-fd-card" aria-label="Loading the playground" />
  ),
});
