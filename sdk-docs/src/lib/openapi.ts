import { existsSync } from 'node:fs';
import path from 'node:path';
import { createOpenAPI } from 'fumadocs-openapi/server';

/**
 * The relayer OpenAPI spec is the single source of truth for the API
 * reference. It is read from the repo at build time, never copied into the
 * portal, so the generated pages always match what the relayer serves at
 * /openapi.json. `next build` runs from sdk-docs/, next to relayer/.
 */
export const relayerSpecPath = path.resolve(process.cwd(), '../relayer/openapi/openapi.yaml');

if (!existsSync(relayerSpecPath)) {
  throw new Error(
    `[api reference] relayer OpenAPI spec not found at ${relayerSpecPath}. ` +
      'Build the portal from a full checkout of the Bosphor repo (sdk-docs/ next to relayer/).',
  );
}

export const openapi = createOpenAPI({
  input: { relayer: relayerSpecPath },
});
