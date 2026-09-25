import { Module } from '@nestjs/common';
import { OPENAPI_SPEC, OpenApiController } from './openapi.controller';
import { loadOpenApiSpec } from './openapi-spec';

@Module({
  controllers: [OpenApiController],
  providers: [{ provide: OPENAPI_SPEC, useFactory: () => loadOpenApiSpec() }],
})
export class OpenApiModule {}
