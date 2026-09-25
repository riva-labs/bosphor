'use client';

import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowRight, ArrowUpRight, BookOpen, MonitorPlay } from 'lucide-react';
import {
  exampleChains,
  examples,
  exampleTypes,
  type ExampleChain,
  type ExampleLink,
  type ExampleType,
} from '@/lib/examples';

function GitHubIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className="size-3.5">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

const linkIcon: Record<ExampleLink['kind'], ReactNode> = {
  github: <GitHubIcon />,
  demo: <MonitorPlay className="size-3.5" aria-hidden />,
  docs: <BookOpen className="size-3.5" aria-hidden />,
};

function ExampleLinkItem({ link }: { link: ExampleLink }) {
  const cls = 'inline-flex items-center gap-1.5 text-fd-primary hover:underline';
  if (link.href.startsWith('/')) {
    return (
      <Link href={link.href} className={cls}>
        {linkIcon[link.kind]}
        {link.label}
        <ArrowRight className="size-3" aria-hidden />
      </Link>
    );
  }
  return (
    <a href={link.href} target="_blank" rel="noreferrer noopener" className={cls}>
      {linkIcon[link.kind]}
      {link.label}
      <ArrowUpRight className="size-3" aria-hidden />
    </a>
  );
}

function Chip<T extends string>({
  value,
  active,
  onClick,
  count,
}: {
  value: T | 'All';
  active: boolean;
  onClick: () => void;
  count: number;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring ${
        active
          ? 'border-fd-foreground bg-fd-foreground text-fd-background'
          : 'bg-fd-card text-fd-muted-foreground hover:bg-fd-accent hover:text-fd-foreground'
      }`}
    >
      {value}
      <span className={active ? 'opacity-70' : 'opacity-60'}>{count}</span>
    </button>
  );
}

/** Filterable card gallery of starters, scripts, reference integrations, and recipes. */
export function ExamplesGallery() {
  const [chain, setChain] = useState<ExampleChain | 'All'>('All');
  const [type, setType] = useState<ExampleType | 'All'>('All');

  const byChain = (c: ExampleChain | 'All') => (e: (typeof examples)[number]) =>
    c === 'All' || e.chains.includes(c);
  const byType = (t: ExampleType | 'All') => (e: (typeof examples)[number]) => t === 'All' || e.type === t;

  const shown = useMemo(() => examples.filter(byChain(chain)).filter(byType(type)), [chain, type]);

  return (
    <div className="not-prose my-6">
      <div className="flex flex-col gap-3 rounded-xl border bg-fd-card/50 p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter by chain">
          <span className="w-12 shrink-0 text-xs font-medium text-fd-muted-foreground">Chain</span>
          {(['All', ...exampleChains] as const).map((c) => (
            <Chip
              key={c}
              value={c}
              active={chain === c}
              onClick={() => setChain(c)}
              count={examples.filter(byType(type)).filter(byChain(c)).length}
            />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter by type">
          <span className="w-12 shrink-0 text-xs font-medium text-fd-muted-foreground">Type</span>
          {(['All', ...exampleTypes] as const).map((t) => (
            <Chip
              key={t}
              value={t}
              active={type === t}
              onClick={() => setType(t)}
              count={examples.filter(byChain(chain)).filter(byType(t)).length}
            />
          ))}
        </div>
      </div>

      <p className="mt-4 text-sm text-fd-muted-foreground" aria-live="polite">
        {shown.length} {shown.length === 1 ? 'example' : 'examples'}
      </p>

      <ul className="mt-3 grid gap-4 md:grid-cols-2">
        {shown.map((e) => (
          <li key={e.title} className="flex min-w-0 flex-col rounded-xl border bg-fd-card p-5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="rounded-md bg-fd-secondary px-2 py-0.5 text-[11px] font-medium text-fd-secondary-foreground">
                {e.type}
              </span>
              {e.chains.map((c) => (
                <span
                  key={c}
                  className="rounded-md border px-2 py-0.5 font-mono text-[11px] text-fd-muted-foreground"
                >
                  {c}
                </span>
              ))}
            </div>
            <h3 className="mt-3 font-display text-base font-bold text-fd-foreground">{e.title}</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-[var(--bosphor-body-text)]">{e.description}</p>
            <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Tags">
              {e.tags.map((t) => (
                <li key={t} className="font-mono text-[11px] text-fd-muted-foreground">
                  #{t.replace(/\s+/g, '-')}
                </li>
              ))}
            </ul>
            <div className="mt-auto flex flex-wrap gap-x-4 gap-y-2 pt-4 text-sm">
              {e.links.map((l) => (
                <ExampleLinkItem key={l.href} link={l} />
              ))}
            </div>
          </li>
        ))}
      </ul>
      {shown.length === 0 ? (
        <p className="mt-4 text-sm text-fd-muted-foreground">No examples match both filters yet.</p>
      ) : null}
    </div>
  );
}
