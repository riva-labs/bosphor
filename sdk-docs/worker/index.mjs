// Cloudflare Worker in front of the static export.
//
// It answers every retired URL from redirects/map.mjs with a 301 to its new
// page and hands everything else to the static assets (env.ASSETS), which apply
// the 404 page as before.
//
// Host move: when CANONICAL_ORIGIN is set (for example "https://docs.bosphor.xyz")
// and a request arrives on any other host (sdk.bosphor.xyz), every page request
// 301s to the same path, after mapping, on the canonical origin. It is unset
// until the docs.bosphor.xyz cutover, so today the site keeps serving on its
// current host.
import { resolveRedirect } from '../redirects/map.mjs';

/**
 * @param {Request} request
 * @param {{ ASSETS: { fetch: (req: Request) => Promise<Response> }, CANONICAL_ORIGIN?: string }} env
 */
export async function handle(request, env) {
  const url = new URL(request.url);
  const mapped = resolveRedirect(url.pathname);
  const canonical = env.CANONICAL_ORIGIN?.replace(/\/+$/, '');
  const offCanonicalHost = Boolean(canonical) && url.origin !== canonical;

  if (mapped || offCanonicalHost) {
    const origin = offCanonicalHost ? canonical : url.origin;
    const target = `${origin}${mapped ?? url.pathname}${url.search}`;
    return new Response(null, {
      status: 301,
      headers: { location: target, 'cache-control': 'public, max-age=3600' },
    });
  }

  return env.ASSETS.fetch(request);
}

export default { fetch: handle };
