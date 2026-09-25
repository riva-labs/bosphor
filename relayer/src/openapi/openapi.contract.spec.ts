import 'reflect-metadata';
import { INestApplication, RequestMethod, Type } from '@nestjs/common';
import { METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import SwaggerParser from '@apidevtools/swagger-parser';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { AddressInfo } from 'node:net';
import { configureHttp } from '../api/http-setup';
import { EvmService } from '../chain/evm/evm.service';
import { SuiService } from '../chain/sui/sui.service';
import { HealthController } from '../health/health.controller';
import { HealthService } from '../health/health.service';
import { IngestController } from '../ingest/ingest.controller';
import { IntentIngest } from '../ingest/intent-ingest.service';
import { InMemoryIntentLifecycleStore } from '../lifecycle/in-memory-intent-lifecycle.store';
import { IntentLifecycleStore } from '../lifecycle/intent-lifecycle.store';
import { PublicController } from '../lifecycle/public.controller';
import { PriceSet } from '../pricing/price-oracle.types';
import { PRICE_ORACLE } from '../pricing/pricing.tokens';
import { QuoteController } from '../pricing/quote.controller';
import { QuoteService } from '../pricing/quote.service';
import { WalrusService } from '../walrus/walrus.service';
import { OPENAPI_SPEC, OpenApiController } from './openapi.controller';
import { loadOpenApiSpec } from './openapi-spec';

// The real config module validates the process env at import time. Route
// discovery only needs module metadata, so swap it for an empty module.
jest.mock('../config/config.module', () => ({ AppConfigModule: class AppConfigModule {} }));
// @solana/web3.js pulls an ESM-only dependency jest cannot load; no Solana code
// runs here, the module graph only needs the import to resolve.
jest.mock('@solana/web3.js', () => ({}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AppModule } = require('../app.module') as { AppModule: Type<unknown> };

/**
 * Contract test for relayer/openapi/openapi.yaml, the public API description.
 * It keeps the spec honest in three ways:
 *  1. the document itself is a valid OpenAPI 3.1 description;
 *  2. every route the Nest app registers (discovered from controller metadata,
 *     starting at AppModule) is documented, and every documented route exists;
 *  3. real responses from the controllers (real QuoteService and HealthService,
 *     stubbed chains and price oracle) validate against the documented schemas.
 */

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'] as const;

/**
 * Routes registered by controllers that are deliberately not part of the public
 * API description. /metrics is not here: it is served by a separate internal
 * server on its own port, not by a Nest controller.
 */
const INTERNAL_ROUTES = new Set<string>([]);

type ModuleRef =
  | Type<unknown>
  | { module: Type<unknown>; controllers?: Type<unknown>[]; imports?: unknown[] }
  | { forwardRef: () => unknown };

/** Walk the module graph from `root` and collect every controller class. */
function collectControllers(root: unknown): Set<Type<unknown>> {
  const seen = new Set<unknown>();
  const controllers = new Set<Type<unknown>>();
  const visit = (entry: unknown): void => {
    if (!entry) return;
    const ref = entry as ModuleRef;
    if (typeof ref === 'object' && 'forwardRef' in ref) return visit(ref.forwardRef());
    if (seen.has(ref)) return;
    seen.add(ref);
    if (typeof ref === 'object' && 'module' in ref) {
      (ref.controllers ?? []).forEach((c) => controllers.add(c));
      (ref.imports ?? []).forEach(visit);
      return visit(ref.module);
    }
    const cls = ref as Type<unknown>;
    const ctrls: Type<unknown>[] = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, cls) ?? [];
    ctrls.forEach((c) => controllers.add(c));
    const imports: unknown[] = Reflect.getMetadata(MODULE_METADATA.IMPORTS, cls) ?? [];
    imports.forEach(visit);
  };
  visit(root);
  return controllers;
}

/** Join Nest path segments and convert `:param` to the OpenAPI `{param}` form. */
function toOpenApiPath(...parts: (string | string[] | undefined)[]): string {
  const segs = parts
    .flatMap((p) => (Array.isArray(p) ? p : [p ?? '']))
    .flatMap((p) => p.split('/'))
    .filter((s) => s.length > 0)
    .map((s) => (s.startsWith(':') ? `{${s.slice(1)}}` : s));
  return '/' + segs.join('/');
}

/** "METHOD /path" for every handler of the given controllers. */
function routesOf(controllers: Iterable<Type<unknown>>): string[] {
  const routes: string[] = [];
  for (const ctrl of controllers) {
    const base: string | string[] | undefined = Reflect.getMetadata(PATH_METADATA, ctrl);
    const proto = ctrl.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor') continue;
      const handler = proto[name];
      if (typeof handler !== 'function') continue;
      const method: RequestMethod | undefined = Reflect.getMetadata(METHOD_METADATA, handler);
      const path: string | string[] | undefined = Reflect.getMetadata(PATH_METADATA, handler);
      if (method === undefined || path === undefined) continue;
      routes.push(`${RequestMethod[method]} ${toOpenApiPath(base, path)}`);
    }
  }
  return routes.sort();
}

type Doc = { paths: Record<string, Record<string, OperationObject>> };
type OperationObject = {
  responses: Record<string, { content?: Record<string, { schema?: object }> }>;
};

describe('OpenAPI spec (relayer/openapi/openapi.yaml)', () => {
  const { json } = loadOpenApiSpec();
  const specRoutes = Object.entries((json as unknown as Doc).paths)
    .flatMap(([path, item]) =>
      Object.keys(item)
        .filter((k) => (HTTP_METHODS as readonly string[]).includes(k))
        .map((m) => `${m.toUpperCase()} ${path}`),
    )
    .sort();

  it('is a valid OpenAPI 3.1 document', async () => {
    await expect(SwaggerParser.validate(structuredClone(json) as never)).resolves.toBeDefined();
    expect(json.openapi).toMatch(/^3\.1\./);
  });

  it('documents exactly the routes the Nest app registers', () => {
    const controllers = collectControllers(AppModule);
    // Sanity: discovery really walked the module graph.
    expect(controllers).toContain(QuoteController);
    expect(controllers).toContain(OpenApiController);
    const appRoutes = routesOf(controllers).filter((r) => !INTERNAL_ROUTES.has(r));

    expect({ undocumented: appRoutes.filter((r) => !specRoutes.includes(r)) }).toEqual({
      undocumented: [],
    });
    expect({ notImplemented: specRoutes.filter((r) => !appRoutes.includes(r)) }).toEqual({
      notImplemented: [],
    });
  });

  describe('responses match the documented schemas', () => {
    const PRICES: PriceSet = {
      WAL: { token: 'WAL', usd: 0.03, publishTimeMs: 1, source: 'test' },
      SUI: { token: 'SUI', usd: 0.8, publishTimeMs: 1, source: 'test' },
      ETH: { token: 'ETH', usd: 2500, publishTimeMs: 1, source: 'test' },
      SOL: { token: 'SOL', usd: 100, publishTimeMs: 1, source: 'test' },
    };
    const INTENT = '0x8d5172b628ac339fdd78c0cd899275cb4c6ae5698bb905f74f51890afaf08b25';

    let app: INestApplication;
    let base: string;
    let deref: Doc;
    let ajv: Ajv2020;
    const ingest = {
      ingest: jest.fn(),
      encode: jest
        .fn()
        .mockResolvedValue({ blobId: 'mLzOEj8l3vxE6CbAvIvtNMeDxOD5DQmvK08kSpFGLp0', size: 5 }),
    };
    const evm = { getBlockNumber: jest.fn().mockResolvedValue(11_779_811) };
    const sui = { getCheckpoint: jest.fn().mockResolvedValue('387649007') };

    beforeAll(async () => {
      deref = (await SwaggerParser.dereference(structuredClone(json) as never)) as unknown as Doc;
      ajv = new Ajv2020({ strict: true, allErrors: true });
      addFormats(ajv);

      const store = new InMemoryIntentLifecycleStore();
      await store.recordHop(INTENT, 'submitted', {
        txHash: '0xaa',
        sender: '0x1111111111111111111111111111111111111111',
        committedBlobId: '0x9d2e46914a244f2baf090df9e0c483c734ed8bbcc026e844fcde253f12cebc98',
        size: 5,
        deadline: Date.now() + 3_600_000,
      });
      await store.recordHop(INTENT, 'stored_walrus', {
        blobId: 'mLzOEj8l3vxE6CbAvIvtNMeDxOD5DQmvK08kSpFGLp0',
        suiObjectId: '0x1f4c',
        endEpoch: 536,
        walCostMist: '12345',
      });

      const configValues: Record<string, unknown> = {
        QUOTE_RETURN_LZ_FEE_MIST: '1760000000',
        QUOTE_SUI_GAS_MIST: '10000000',
        RATE_LIMIT_PER_IP: 1000,
        // Small encode budget so the 429 test can trip it (the encode test uses 2).
        RATE_LIMIT_ENCODE_PER_IP: 3,
      };
      const config = {
        get: (key: string, def?: unknown) => (key in configValues ? configValues[key] : def),
        getOrThrow: (key: string) => {
          if (key in configValues) return configValues[key];
          throw new Error(`missing ${key}`);
        },
      };

      const moduleRef = await Test.createTestingModule({
        controllers: [
          HealthController,
          QuoteController,
          IngestController,
          PublicController,
          OpenApiController,
        ],
        providers: [
          HealthService,
          QuoteService,
          { provide: EvmService, useValue: evm },
          { provide: SuiService, useValue: sui },
          { provide: PRICE_ORACLE, useValue: { getPrices: async () => PRICES } },
          {
            provide: WalrusService,
            useValue: { estimateWalCostFrost: async () => 34_840_000n, maxStoreEpochs: 53 },
          },
          { provide: ConfigService, useValue: config },
          { provide: IntentIngest, useValue: ingest },
          { provide: IntentLifecycleStore, useValue: store },
          { provide: OPENAPI_SPEC, useValue: loadOpenApiSpec() },
        ],
      }).compile();
      app = moduleRef.createNestApplication({ logger: false });
      configureHttp(app, config as never, { recordRateLimited: () => undefined });
      await app.listen(0, '127.0.0.1');
      base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      await app?.close();
    });

    /**
     * Assert the response status is documented for the operation and the JSON
     * body validates against the documented schema for that status.
     */
    async function expectDocumented(method: string, path: string, res: Response): Promise<unknown> {
      const op = deref.paths[path]?.[method];
      expect(op).toBeDefined();
      const documented = op.responses[String(res.status)];
      expect({ status: res.status, documented: Boolean(documented) }).toEqual({
        status: res.status,
        documented: true,
      });
      const schema = documented.content?.['application/json']?.schema;
      expect(schema).toBeDefined();
      const body: unknown = await res.json();
      const validate = ajv.compile(schema as object);
      expect({ body, errors: validate(body) ? null : validate.errors }).toEqual({
        body,
        errors: null,
      });
      return body;
    }

    const post = (path: string, body: BodyInit, headers: Record<string, string>) =>
      fetch(`${base}${path}`, { method: 'POST', body, headers });
    const jsonHeaders = { 'content-type': 'application/json' };
    const octets = { 'content-type': 'application/octet-stream' };

    it('POST /quote (real QuoteService) returns the documented quote', async () => {
      const res = await post(
        '/quote',
        JSON.stringify({
          sizeBytes: 1024,
          epochs: 5,
          originToken: 'ETH',
          forwardLzFeeNative: '1211000000000000',
          originGasNative: '40000000000000',
        }),
        jsonHeaders,
      );
      expect(res.headers.get('x-ratelimit-limit')).toBe('1000');
      const body = (await expectDocumented('post', '/quote', res)) as Record<string, string>;
      expect(BigInt(body.totalNative)).toBe(BigInt(body.escrowNative) + BigInt(body.forwardNative));
    });

    it('POST /quote with out-of-range epochs returns the documented 400', async () => {
      const res = await post(
        '/quote',
        JSON.stringify({ sizeBytes: 1, epochs: 54, originToken: 'SOL' }),
        jsonHeaders,
      );
      expect(res.status).toBe(400);
      await expectDocumented('post', '/quote', res);
    });

    it.each([
      ['an unsupported originToken', { sizeBytes: 1, originToken: 'DOGE' }],
      ['a missing sizeBytes', { originToken: 'ETH' }],
      ['a negative sizeBytes', { sizeBytes: -5, originToken: 'ETH' }],
      ['a fractional sizeBytes', { sizeBytes: 1.5, originToken: 'ETH' }],
      [
        'a non-decimal forwardLzFeeNative',
        { sizeBytes: 1, originToken: 'ETH', forwardLzFeeNative: '0x10' },
      ],
    ])('POST /quote with %s returns the documented 400 (never a 500)', async (_label, body) => {
      const res = await post('/quote', JSON.stringify(body), jsonHeaders);
      expect(res.status).toBe(400);
      await expectDocumented('post', '/quote', res);
    });

    it('POST /quote with a malformed X-Bosphor-App returns the documented 400', async () => {
      const res = await post('/quote', JSON.stringify({ sizeBytes: 1, originToken: 'ETH' }), {
        ...jsonHeaders,
        'X-Bosphor-App': 'not a slug!',
      });
      expect(res.status).toBe(400);
      await expectDocumented('post', '/quote', res);
    });

    it('GET /health (real HealthService) returns the documented status, ok and degraded', async () => {
      const ok = (await expectDocumented('get', '/health', await fetch(`${base}/health`))) as {
        status: string;
      };
      expect(ok.status).toBe('ok');
      sui.getCheckpoint.mockRejectedValueOnce(new Error('down'));
      const degraded = (await expectDocumented(
        'get',
        '/health',
        await fetch(`${base}/health`),
      )) as {
        status: string;
      };
      expect(degraded.status).toBe('degraded');
    });

    it('GET /public/intents returns the documented feed', async () => {
      const res = await fetch(`${base}/public/intents?limit=5`);
      const body = (await expectDocumented('get', '/public/intents', res)) as { count: number };
      expect(body.count).toBe(1);
    });

    it('POST /blob/encode returns the documented blob id, and 400 on an empty body', async () => {
      await expectDocumented('post', '/blob/encode', await post('/blob/encode', 'hello', octets));
      const empty = await post('/blob/encode', new Uint8Array(0), octets);
      expect(empty.status).toBe(400);
      await expectDocumented('post', '/blob/encode', empty);
    });

    it('POST /blob/{intentId} returns the documented ack and rejections', async () => {
      ingest.ingest.mockResolvedValueOnce({
        ok: true,
        intentId: INTENT,
        blobId: 'mLzOEj8l3vxE6CbAvIvtNMeDxOD5DQmvK08kSpFGLp0',
        size: 5,
      });
      await expectDocumented(
        'post',
        '/blob/{intentId}',
        await post(`/blob/${INTENT}`, 'hello', octets),
      );

      const reasons = [
        ['unknown', 404],
        ['already-executed', 409],
        ['expired', 410],
        ['oversized', 413],
        ['wrong-size', 422],
        ['wrong-blob-id', 422],
        ['backpressure', 503],
      ] as const;
      for (const [reason, status] of reasons) {
        ingest.ingest.mockResolvedValueOnce({
          ok: false,
          intentId: INTENT,
          reason,
          message: reason,
        });
        const res = await post(`/blob/${INTENT}`, 'hello', octets);
        expect(res.status).toBe(status);
        await expectDocumented('post', '/blob/{intentId}', res);
        if (status === 503) expect(res.headers.get('retry-after')).toBe('5');
      }
    });

    it('an exhausted rate limit returns the documented 429 with Retry-After', async () => {
      let res = await post('/blob/encode', 'hello', octets);
      for (let i = 0; i < 5 && res.status !== 429; i++) {
        res = await post('/blob/encode', 'hello', octets);
      }
      expect(res.status).toBe(429);
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
      expect(res.headers.get('x-ratelimit-remaining')).toBe('0');
      await expectDocumented('post', '/blob/encode', res);
    });

    it('GET /openapi.json and /openapi.yaml serve the spec', async () => {
      const res = await fetch(`${base}/openapi.json`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(json);
      const yaml = await fetch(`${base}/openapi.yaml`);
      expect(yaml.status).toBe(200);
      expect(yaml.headers.get('content-type')).toContain('application/yaml');
      expect(await yaml.text()).toBe(loadOpenApiSpec().yaml);
    });
  });
});
