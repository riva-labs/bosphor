import type { MetadataRoute } from 'next';
import { source } from '@/lib/source';

const BASE = 'https://sdk.bosphor.xyz';

export const dynamic = 'force-static';

export default function sitemap(): MetadataRoute.Sitemap {
  const pages = source.getPages().map((page) => ({
    url: `${BASE}${page.url}`,
    changeFrequency: 'weekly' as const,
    priority: page.url === '/docs' ? 1 : 0.7,
  }));

  return [
    {
      url: BASE,
      changeFrequency: 'weekly',
      priority: 1,
    },
    ...pages,
  ];
}
