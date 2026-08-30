import {
  ConflictException,
  GoneException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { IngestController } from './ingest.controller';
import { IntentIngest } from './intent-ingest.service';
import { IngestResult } from './intent-ingest.types';

const INTENT_ID = '0x' + 'ab'.repeat(32);

/** Minimal Response stand-in that records header() calls. */
function fakeRes(): { headers: Record<string, string>; header(n: string, v: string): unknown } {
  const headers: Record<string, string> = {};
  return {
    headers,
    header(name: string, value: string) {
      headers[name] = value;
      return this;
    },
  };
}

function controllerFor(result: IngestResult): {
  ctrl: IngestController;
  res: ReturnType<typeof fakeRes>;
} {
  const ingest = { ingest: jest.fn().mockResolvedValue(result) } as unknown as IntentIngest;
  return { ctrl: new IngestController(ingest), res: fakeRes() };
}

const req = (bytes: Buffer) => ({ body: bytes });

describe('IngestController', () => {
  it('returns the ack on accept', async () => {
    const { ctrl, res } = controllerFor({ ok: true, intentId: INTENT_ID, blobId: 'blob', size: 5 });
    const ack = await ctrl.ingestBlob(INTENT_ID, req(Buffer.from('hello')), res);
    expect(ack).toEqual({ intentId: INTENT_ID, blobId: 'blob', size: 5 });
  });

  it('maps backpressure to 503 and sets Retry-After', async () => {
    const { ctrl, res } = controllerFor({
      ok: false,
      intentId: INTENT_ID,
      reason: 'backpressure',
      message: 'queue full',
    });

    await expect(ctrl.ingestBlob(INTENT_ID, req(Buffer.from('hello')), res)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(res.headers['Retry-After']).toBe('5');
  });

  it.each([
    ['unknown', NotFoundException],
    ['already-executed', ConflictException],
    ['expired', GoneException],
    ['wrong-size', UnprocessableEntityException],
    ['wrong-blob-id', UnprocessableEntityException],
  ] as const)('maps %s to the right HTTP error without a Retry-After', async (reason, Exc) => {
    const { ctrl, res } = controllerFor({ ok: false, intentId: INTENT_ID, reason, message: 'no' });
    await expect(ctrl.ingestBlob(INTENT_ID, req(Buffer.from('hello')), res)).rejects.toBeInstanceOf(
      Exc,
    );
    expect(res.headers['Retry-After']).toBeUndefined();
  });

  it('maps oversized to 413', async () => {
    const { ctrl, res } = controllerFor({
      ok: false,
      intentId: INTENT_ID,
      reason: 'oversized',
      message: 'too big',
    });
    await expect(ctrl.ingestBlob(INTENT_ID, req(Buffer.from('hello')), res)).rejects.toMatchObject({
      status: 413,
    });
    expect(HttpException).toBeDefined();
  });

  it('rejects an empty body with 400 before touching the service', async () => {
    const { ctrl, res } = controllerFor({ ok: true, intentId: INTENT_ID, blobId: 'b', size: 0 });
    await expect(ctrl.ingestBlob(INTENT_ID, req(Buffer.alloc(0)), res)).rejects.toMatchObject({
      status: 400,
    });
  });
});
