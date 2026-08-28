import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { Provider } from '@/components/provider';
import { SiteStructuredData } from '@/components/structured-data';
import { Analytics } from '@/components/analytics';
import './global.css';

const inter = Inter({
  subsets: ['latin'],
});

const description =
  'TypeScript SDK for Bosphor: store a file on Walrus from an EVM or Solana wallet, over LayerZero, with a verifiable proof back on the origin chain.';

export const metadata: Metadata = {
  metadataBase: new URL('https://sdk.bosphor.xyz'),
  title: {
    default: 'Bosphor SDK',
    template: '%s · Bosphor SDK',
  },
  description,
  applicationName: 'Bosphor SDK',
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
  ],
  authors: [{ name: 'Bosphor', url: 'https://bosphor.xyz' }],
  openGraph: {
    type: 'website',
    siteName: 'Bosphor SDK',
    title: 'Bosphor SDK',
    description,
    url: 'https://sdk.bosphor.xyz',
    locale: 'en_US',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Bosphor SDK',
    description,
  },
  alternates: {
    canonical: '/',
  },
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <SiteStructuredData />
        <Analytics />
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
