import { buildLlmsTxt } from '@/lib/llms';

export const revalidate = false;

export function GET() {
  return new Response(buildLlmsTxt(), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
