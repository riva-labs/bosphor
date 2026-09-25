import type { Metadata } from 'next';
import Link from 'next/link';
import type { ComponentType, ReactNode, SVGProps } from 'react';
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Braces,
  FileCode,
  LayoutGrid,
  MonitorPlay,
  Network,
  Package,
  Play,
  Rocket,
  ScrollText,
  Webhook,
} from 'lucide-react';
import { CopyCommand } from '@/components/home/copy-command';
import { links, tagline } from '@/lib/shared';

export const metadata: Metadata = {
  title: { absolute: `Bosphor Docs: ${tagline}` },
  alternates: { canonical: '/' },
};

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

const sections: { title: string; href: string; icon: Icon; body: string }[] = [
  {
    title: 'Get started',
    href: '/docs',
    icon: Rocket,
    body: 'What Bosphor is, the quickstart, and how a store travels across chains.',
  },
  {
    title: 'Guides',
    href: '/docs/guides/pay-for-storage',
    icon: BookOpen,
    body: 'Pay for storage, drive each step yourself, build a dApp, recover from errors.',
  },
  {
    title: 'SDK reference',
    href: '/docs/reference',
    icon: Braces,
    body: 'Every type, function, and error in @bosphor/sdk, by entry point.',
  },
  {
    title: 'API reference',
    href: '/docs/api',
    icon: Webhook,
    body: 'The relayer HTTP API: the intent feed, quotes, and blob upload.',
  },
  {
    title: 'Contracts',
    href: '/docs/contracts',
    icon: FileCode,
    body: 'The EVM adapter, the Solana program, the Sui executor, and the commitment format.',
  },
  {
    title: 'Examples',
    href: '/docs/examples',
    icon: LayoutGrid,
    body: 'Starter repos for EVM and Solana, and runnable SDK scripts.',
  },
  {
    title: 'Playground',
    href: '/docs/playground',
    icon: Play,
    body: 'Price a store with no wallet, then run a real round-trip on testnet.',
  },
  {
    title: 'Protocol',
    href: '/docs/protocol',
    icon: Network,
    body: 'Architecture, security model, operations, and the evidence that it works.',
  },
];

const chains: {
  name: string;
  network: string;
  token: string;
  links: { label: string; href: string }[];
}[] = [
  {
    name: 'EVM',
    network: 'Ethereum Sepolia',
    token: 'ETH',
    links: [
      { label: 'Quickstart', href: '/docs/quickstart' },
      { label: 'EVM guide', href: '/docs/guides/evm' },
      { label: 'EVM adapter', href: '/docs/contracts/evm-adapter' },
      { label: 'Starter repo', href: 'https://github.com/riva-labs/bosphor-evm-starter' },
    ],
  },
  {
    name: 'Solana',
    network: 'Solana devnet',
    token: 'SOL',
    links: [
      { label: 'Quickstart', href: '/docs/quickstart' },
      { label: 'Solana guide', href: '/docs/guides/solana' },
      { label: 'Solana program', href: '/docs/contracts/solana-program' },
      { label: 'Starter repo', href: 'https://github.com/riva-labs/bosphor-solana-starter' },
    ],
  },
];

function GitHubIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

const resources: { label: string; detail: string; href: string; icon: Icon }[] = [
  { label: 'GitHub', detail: 'riva-labs/bosphor', href: links.github, icon: GitHubIcon },
  { label: 'npm', detail: '@bosphor/sdk', href: links.npm, icon: Package },
  { label: 'Status', detail: 'status.bosphor.xyz', href: links.status, icon: Activity },
  { label: 'Demo dApp', detail: 'demo.bosphor.xyz', href: links.demo, icon: MonitorPlay },
];

function SmartLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  if (href.startsWith('http')) {
    return (
      <a href={href} className={className} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-fd-muted-foreground">
      {children}
    </p>
  );
}

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col">
      {/* Hero */}
      <section className="relative overflow-hidden border-b bg-gradient-to-b from-[var(--bosphor-hero-from)] to-[var(--bosphor-hero-to)]">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.35] [background-image:linear-gradient(to_right,var(--color-fd-border)_1px,transparent_1px),linear-gradient(to_bottom,var(--color-fd-border)_1px,transparent_1px)] [background-size:56px_56px] [mask-image:radial-gradient(ellipse_at_top,black_20%,transparent_70%)]"
        />
        <div className="relative mx-auto grid w-full max-w-6xl gap-12 px-4 py-16 sm:px-6 md:py-24 lg:grid-cols-[1.1fr_1fr] lg:items-center">
          <div className="min-w-0">
            <Eyebrow>Developer portal</Eyebrow>
            <h1 className="mt-5 text-[2.5rem] font-black leading-[1.05] tracking-tight text-fd-foreground sm:text-5xl lg:text-6xl">
              Making Permanence <em>Portable</em>
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-[var(--bosphor-body-text)]">
              Pay once on EVM or Solana. Bosphor stores your file on Walrus and returns a
              verifiable proof to the chain you started from, in one SDK call.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href="/docs/quickstart"
                className="inline-flex items-center gap-2 rounded-lg bg-fd-foreground px-5 py-2.5 text-sm font-semibold text-fd-background transition-opacity hover:opacity-90"
              >
                Quickstart
                <ArrowRight className="size-4" />
              </Link>
              <Link
                href="/docs/playground"
                className="inline-flex items-center gap-2 rounded-lg border bg-fd-card/60 px-5 py-2.5 text-sm font-semibold text-fd-foreground transition-colors hover:bg-fd-accent"
              >
                <Play className="size-4" />
                Playground
              </Link>
            </div>
          </div>

          <div className="min-w-0 rounded-xl border bg-fd-card/80 shadow-2xl shadow-black/10 backdrop-blur">
            <div className="flex items-center justify-between border-b px-4 py-2.5">
              <span className="font-mono text-xs text-fd-muted-foreground">store.ts</span>
              <span className="rounded border px-1.5 py-px font-mono text-[10px] uppercase tracking-wider text-fd-muted-foreground">
                testnet
              </span>
            </div>
            <div className="space-y-4 p-4">
              <CopyCommand command="npm i @bosphor/sdk" />
              <pre className="overflow-x-auto text-[13px] leading-6 text-fd-foreground">
                <code>
                  <span className="text-fd-muted-foreground">{'import'}</span>
                  {" { createBosphorClientFromSigner } "}
                  <span className="text-fd-muted-foreground">{'from'}</span>
                  {" '@bosphor/sdk/evm';\n\n"}
                  <span className="text-fd-muted-foreground">{'const'}</span>
                  {' client = '}
                  <span className="text-fd-muted-foreground">{'await'}</span>
                  {' createBosphorClientFromSigner(signer);\n'}
                  <span className="text-fd-muted-foreground">{'const'}</span>
                  {' { blobId, endEpoch } = '}
                  <span className="text-fd-muted-foreground">{'await'}</span>
                  {' client.storePriced(bytes, {\n  epochs: 5,\n});\n'}
                  <span className="text-fd-muted-foreground">
                    {'// verified on-chain: the proof came back from Sui'}
                  </span>
                </code>
              </pre>
            </div>
          </div>
        </div>
      </section>

      {/* Choose your chain */}
      <section className="mx-auto w-full max-w-6xl px-4 sm:px-6 pt-16">
        <Eyebrow>Choose your chain</Eyebrow>
        <h2 className="mt-3 text-2xl font-bold tracking-tight text-fd-foreground">
          Same API, <em>either origin</em>
        </h2>
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          {chains.map((chain) => (
            <div key={chain.name} className="rounded-xl border bg-fd-card p-5">
              <div className="flex items-baseline justify-between gap-4">
                <h3 className="text-lg font-bold text-fd-foreground">{chain.name}</h3>
                <span className="font-mono text-xs text-fd-muted-foreground">
                  {chain.network} · pay in {chain.token}
                </span>
              </div>
              <ul className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                {chain.links.map((l) => (
                  <li key={l.label}>
                    <SmartLink
                      href={l.href}
                      className="inline-flex items-center gap-1 text-fd-primary hover:underline"
                    >
                      {l.label}
                      {l.href.startsWith('http') ? (
                        <ArrowUpRight className="size-3.5" />
                      ) : (
                        <ArrowRight className="size-3.5" />
                      )}
                    </SmartLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {/* Sections */}
      <section className="mx-auto w-full max-w-6xl px-4 sm:px-6 pt-16">
        <Eyebrow>Explore the docs</Eyebrow>
        <h2 className="mt-3 text-2xl font-bold tracking-tight text-fd-foreground">
          Everything to <em>build, ship, and verify</em>
        </h2>
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {sections.map((s) => (
            <Link
              key={s.title}
              href={s.href}
              className="group flex flex-col rounded-xl border bg-fd-card p-5 transition-colors hover:border-[var(--bosphor-faint)] hover:bg-fd-accent/40"
            >
              <span className="flex size-9 items-center justify-center rounded-lg border bg-fd-secondary text-fd-foreground">
                <s.icon className="size-4.5" />
              </span>
              <span className="mt-4 flex items-center gap-1.5 font-display text-base font-bold text-fd-foreground">
                {s.title}
                <ArrowRight className="size-3.5 -translate-x-1 opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100" />
              </span>
              <span className="mt-1.5 text-sm leading-relaxed text-fd-muted-foreground">{s.body}</span>
            </Link>
          ))}
        </div>
      </section>

      {/* Resources */}
      <section className="mx-auto w-full max-w-6xl px-4 sm:px-6 py-16">
        <div className="grid gap-4 rounded-xl border bg-fd-card p-2 sm:grid-cols-2 lg:grid-cols-4">
          {resources.map((r) => (
            <a
              key={r.label}
              href={r.href}
              target="_blank"
              rel="noreferrer noopener"
              className="flex items-center gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-fd-accent/50"
            >
              <r.icon className="size-5 shrink-0 text-fd-muted-foreground" />
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-fd-foreground">{r.label}</span>
                <span className="block truncate font-mono text-xs text-fd-muted-foreground">
                  {r.detail}
                </span>
              </span>
              <ArrowUpRight className="ml-auto size-4 shrink-0 text-fd-muted-foreground" />
            </a>
          ))}
        </div>
        <p className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-fd-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <ScrollText className="size-4" />
            <Link href="/docs/changelog" className="text-fd-primary hover:underline">
              Changelog
            </Link>
          </span>
          <span>
            For AI assistants:{' '}
            <a href="/llms.txt" className="text-fd-primary hover:underline">
              llms.txt
            </a>{' '}
            and{' '}
            <a href="/llms-full.txt" className="text-fd-primary hover:underline">
              llms-full.txt
            </a>
          </span>
        </p>
      </section>

      <footer className="mt-auto border-t">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-8 text-sm text-fd-muted-foreground">
          <span>
            <span className="font-display font-bold text-fd-foreground">Bosphor</span>
            <span className="mx-2">·</span>
            <span className="accent-serif text-base">{tagline}</span>
          </span>
          <span>
            Stores on{' '}
            <a href="https://www.walrus.xyz/" className="text-fd-primary hover:underline">
              Walrus
            </a>{' '}
            over{' '}
            <a href="https://layerzero.network/" className="text-fd-primary hover:underline">
              LayerZero
            </a>
          </span>
        </div>
      </footer>
    </main>
  );
}
