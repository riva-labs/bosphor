import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { Provider } from '@/components/provider';
import './global.css';

const inter = Inter({
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: new URL('https://sdk.bosphor.xyz'),
  title: {
    default: 'Bosphor SDK',
    template: '%s · Bosphor SDK',
  },
  description:
    'TypeScript SDK for Bosphor: store a file on Walrus from an EVM or Solana wallet, over LayerZero, with a verifiable proof back on the origin chain.',
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
