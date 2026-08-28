import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  reactStrictMode: true,
  // Static export has no image optimizer, so serve images as-is (the logo would
  // otherwise 404 behind /_next/image on Cloudflare).
  images: { unoptimized: true },
  // This app lives in a monorepo; pin the workspace root to silence Next's
  // "multiple lockfiles" inference warning and keep resolution deterministic.
  turbopack: { root: import.meta.dirname },
};

export default withMDX(config);
