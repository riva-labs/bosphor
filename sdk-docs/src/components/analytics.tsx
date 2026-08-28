import Script from 'next/script';

// Privacy-friendly, cookieless analytics (Plausible). Off by default: it only
// renders when NEXT_PUBLIC_PLAUSIBLE_DOMAIN is set at build time, so no tracking
// ships until it is explicitly configured. Point NEXT_PUBLIC_PLAUSIBLE_SRC at a
// self-hosted instance if you don't use plausible.io.
export function Analytics() {
  const domain = process.env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN;
  if (!domain) return null;

  const src = process.env.NEXT_PUBLIC_PLAUSIBLE_SRC ?? 'https://plausible.io/js/script.js';

  return <Script defer data-domain={domain} src={src} strategy="afterInteractive" />;
}
