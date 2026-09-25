import type { Metadata } from 'next';
import { Instrument_Sans, Instrument_Serif, JetBrains_Mono } from 'next/font/google';
import { Provider } from '@/components/provider';
import { SiteStructuredData } from '@/components/structured-data';
import { Analytics } from '@/components/analytics';
import { appName, siteDescription, siteUrl } from '@/lib/shared';
import './global.css';

// Body, code, and the serif accent come from Google Fonts via next/font (self
// hosted at build time). Satoshi, the display face, is on Fontshare and loads
// from its CDN below.
const instrumentSans = Instrument_Sans({
  subsets: ['latin'],
  variable: '--font-instrument-sans',
  display: 'swap',
});

const instrumentSerif = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  style: ['italic'],
  variable: '--font-instrument-serif',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: appName,
    template: `%s · ${appName}`,
  },
  description: siteDescription,
  applicationName: appName,
  keywords: [
    'Bosphor',
    'Walrus',
    'Sui',
    'LayerZero',
    'cross-chain storage',
    'TypeScript SDK',
    'EVM',
    'Solana',
    'decentralized storage',
    'developer portal',
  ],
  authors: [{ name: 'Bosphor', url: 'https://bosphor.xyz' }],
  openGraph: {
    type: 'website',
    siteName: appName,
    title: appName,
    description: siteDescription,
    url: siteUrl,
    locale: 'en_US',
  },
  twitter: {
    card: 'summary_large_image',
    title: appName,
    description: siteDescription,
  },
  alternates: {
    canonical: '/',
  },
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      className={`${instrumentSans.variable} ${instrumentSerif.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <link rel="preconnect" href="https://api.fontshare.com" />
        <link rel="preconnect" href="https://cdn.fontshare.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://api.fontshare.com/v2/css?f[]=satoshi@700,900&display=swap"
        />
      </head>
      <body className="flex min-h-screen flex-col">
        <SiteStructuredData />
        <Analytics />
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
