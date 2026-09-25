import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/**
 * Location of the OpenAPI document. It lives beside src/ and dist/
 * (relayer/openapi/openapi.yaml), so the same relative path works from the ts
 * sources, the compiled build and the Docker image (which copies openapi/ next
 * to dist/).
 */
export const OPENAPI_SPEC_PATH = join(__dirname, '..', '..', 'openapi', 'openapi.yaml');

/** The spec in both served forms, read once. */
export interface OpenApiSpec {
  yaml: string;
  json: Record<string, unknown>;
}

/**
 * Read and parse the spec. Throws if the file is missing or is not an OpenAPI
 * document, so a broken image fails at startup instead of serving an empty
 * description.
 */
export function loadOpenApiSpec(path: string = OPENAPI_SPEC_PATH): OpenApiSpec {
  const yaml = readFileSync(path, 'utf8');
  const json: unknown = parse(yaml);
  if (!json || typeof json !== 'object' || !('openapi' in json)) {
    throw new Error(`${path} is not an OpenAPI document`);
  }
  return { yaml, json: json as Record<string, unknown> };
}
