import Link from 'next/link';
import { links, tagline } from '@/lib/shared';

const columns: { title: string; items: { label: string; href: string }[] }[] = [
  {
    title: 'Product',
    items: [
      { label: 'Docs', href: '/docs' },
      { label: 'Examples', href: '/docs/examples' },
      { label: 'Playground', href: '/docs/playground' },
      { label: 'Demo', href: links.demo },
    ],
  },
  {
    title: 'Developers',
    items: [
      { label: 'SDK on npm', href: links.npm },
      { label: 'GitHub', href: links.github },
      { label: 'API reference', href: '/docs/api' },
      { label: 'Changelog', href: '/docs/changelog' },
    ],
  },
  {
    title: 'Resources',
    items: [
      { label: 'Status', href: links.status },
      { label: 'AI assistants', href: '/docs/ai-assistants' },
      { label: 'llms.txt', href: '/llms.txt' },
      { label: 'bosphor.xyz', href: links.site },
    ],
  },
];

function FooterLink({ href, children }: { href: string; children: string }) {
  const cls = 'text-fd-muted-foreground transition-colors hover:text-fd-foreground';
  if (href.startsWith('http')) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener" className={cls}>
        {children}
      </a>
    );
  }
  // Plain-text endpoints (llms.txt) are not Next routes, so skip client routing.
  if (href.endsWith('.txt')) {
    return (
      <a href={href} className={cls}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={cls}>
      {children}
    </Link>
  );
}

/** Site-wide footer with product links, shown on the home page and every docs page. */
export function SiteFooter({ className = '' }: { className?: string }) {
  return (
    <footer className={`border-t text-sm ${className}`}>
      <div className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-10 sm:px-6 md:grid-cols-[1.4fr_repeat(3,1fr)]">
        <div className="min-w-0">
          <p className="font-display text-base font-bold text-fd-foreground">Bosphor</p>
          <p className="accent-serif mt-1 text-base text-fd-muted-foreground">{tagline}</p>
          <p className="mt-3 max-w-xs text-fd-muted-foreground">
            Stores on{' '}
            <a href="https://www.walrus.xyz/" className="text-fd-primary hover:underline">
              Walrus
            </a>{' '}
            over{' '}
            <a href="https://layerzero.network/" className="text-fd-primary hover:underline">
              LayerZero
            </a>
            , from EVM and Solana.
          </p>
        </div>
        {columns.map((col) => (
          <nav key={col.title} aria-label={col.title} className="min-w-0">
            <p className="font-medium text-fd-foreground">{col.title}</p>
            <ul className="mt-3 space-y-2">
              {col.items.map((item) => (
                <li key={item.label}>
                  <FooterLink href={item.href}>{item.label}</FooterLink>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
    </footer>
  );
}
