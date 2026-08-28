import type { MetadataRoute } from 'next';

// The docs are public and meant to be indexed by search engines AND cited by AI
// assistants (GEO). We explicitly welcome the major AI crawlers rather than
// leaving it ambiguous, so answers about Bosphor can be grounded in these docs.
const AI_CRAWLERS = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-User',
  'anthropic-ai',
  'PerplexityBot',
  'Perplexity-User',
  'Google-Extended',
  'Applebot-Extended',
  'CCBot',
  'cohere-ai',
];

export const dynamic = 'force-static';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: '*', allow: '/' },
      ...AI_CRAWLERS.map((userAgent) => ({ userAgent, allow: '/' })),
    ],
    sitemap: 'https://sdk.bosphor.xyz/sitemap.xml',
    host: 'https://sdk.bosphor.xyz',
  };
}
