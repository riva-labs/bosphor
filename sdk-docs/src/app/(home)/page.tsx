'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

// The docs live under /docs; the root sends visitors straight there (a client
// redirect, since the site is a static export).
export default function HomePage() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/docs');
  }, [router]);

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
      {/* No-JS / crawler fallback: React 19 hoists this into <head>. */}
      <meta httpEquiv="refresh" content="1; url=/docs" />
      <p className="text-fd-muted-foreground text-sm">Redirecting to the docs…</p>
      <Link href="/docs" className="text-fd-primary font-medium underline">
        Open the Bosphor SDK docs
      </Link>
    </div>
  );
}
