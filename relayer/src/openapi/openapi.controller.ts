import { Controller, Get, Header, Inject } from '@nestjs/common';
import { OpenApiSpec } from './openapi-spec';

/** Injection token for the loaded spec (lets tests supply their own). */
export const OPENAPI_SPEC = Symbol('OPENAPI_SPEC');

/**
 * Serves the relayer's own OpenAPI description so the developer portal and API
 * tools can fetch it from the relayer they talk to. GET only, so the integrator
 * rate limits (POST routes) never apply.
 */
@Controller()
export class OpenApiController {
  constructor(@Inject(OPENAPI_SPEC) private readonly spec: OpenApiSpec) {}

  @Get('openapi.json')
  getJson(): Record<string, unknown> {
    return this.spec.json;
  }

  @Get('openapi.yaml')
  @Header('Content-Type', 'application/yaml; charset=utf-8')
  getYaml(): string {
    return this.spec.yaml;
  }
}
