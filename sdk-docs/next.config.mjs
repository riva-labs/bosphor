import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  reactStrictMode: true,
  // Static export has no image optimizer, so serve images as-is (the logo would
  // otherwise 404 behind /_next/image on Cloudflare).
  images: { unoptimized: true },
};

export default withMDX(config);
