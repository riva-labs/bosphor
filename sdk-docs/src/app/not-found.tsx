import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { HomeLayout } from 'fumadocs-ui/layouts/home';
import { baseOptions } from '@/lib/layout.shared';
import { SearchButton } from '@/components/search-button';
import { SiteFooter } from '@/components/site-footer';

export const metadata: Metadata = {
  title: 'Page not found',
  robots: { index: false },
};

const popular = [
  { label: 'Quickstart', href: '/docs/quickstart' },
  { label: 'Pay for storage', href: '/docs/guides/pay-for-storage' },
  { label: 'SDK reference', href: '/docs/reference' },
  { label: 'Examples', href: '/docs/examples' },
  { label: 'API reference', href: '/docs/api' },
];

export default function NotFound() {
  return (
    <HomeLayout {...baseOptions()}>
      <main className="flex flex-1 flex-col">
        <section className="relative flex flex-1 flex-col items-center justify-center overflow-hidden bg-gradient-to-b from-[var(--bosphor-hero-from)] to-[var(--bosphor-hero-to)] px-4 py-20 text-center">
          <Image
            src="/mascot-peek.png"
            alt=""
            width={120}
            height={120}
            className="mb-6 h-auto w-24 opacity-90"
          />
          <p className="font-mono text-sm text-fd-muted-foreground">404</p>
          <h1 className="mt-3 text-4xl font-black tracking-tight text-fd-foreground sm:text-5xl">
            This page is not <em>here</em>
          </h1>
          <p className="mt-4 max-w-md text-[var(--bosphor-body-text)]">
            It may have moved when the docs were reorganized. Search for it, or start from one of
            the pages below.
          </p>
          <div className="mt-8 flex w-full justify-center">
            <SearchButton />
          </div>
          <ul className="mt-8 flex flex-wrap justify-center gap-x-5 gap-y-2 text-sm">
            {popular.map((p) => (
              <li key={p.href}>
                <Link href={p.href} className="inline-flex items-center gap-1 text-fd-primary hover:underline">
                  {p.label}
                  <ArrowRight className="size-3.5" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </section>
        <SiteFooter />
      </main>
    </HomeLayout>
  );
}
