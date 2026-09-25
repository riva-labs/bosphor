'use client';

import { useState } from 'react';
import { DynamicCodeBlock } from 'fumadocs-ui/components/dynamic-codeblock';
import { quoteSnippet, storeSnippet, type SnippetInput } from './format';

const tabs = [
  { id: 'quote', label: 'Quote (no wallet)', build: quoteSnippet },
  { id: 'store', label: 'Paid store', build: storeSnippet },
] as const;

/** The SDK calls equivalent to the current playground options, kept in sync. */
export function CodePanel(props: SnippetInput) {
  const [tab, setTab] = useState<(typeof tabs)[number]['id']>('quote');
  const active = tabs.find((t) => t.id === tab) ?? tabs[0];
  return (
    <div className="rounded-xl border bg-fd-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
        <span className="text-sm font-medium text-fd-foreground">The same thing in code</span>
        <div role="tablist" aria-label="Snippet" className="flex gap-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring ${
                tab === t.id
                  ? 'bg-fd-accent text-fd-accent-foreground'
                  : 'text-fd-muted-foreground hover:text-fd-foreground'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="px-3 pb-1 [&_figure]:my-2">
        <DynamicCodeBlock lang="ts" code={active.build(props)} />
      </div>
    </div>
  );
}
