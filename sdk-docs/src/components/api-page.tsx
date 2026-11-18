'use client';

import { createOpenAPIPage } from 'fumadocs-openapi/ui';
import { createCodeUsageGeneratorRegistry } from 'fumadocs-openapi/requests/generators';
import { curl } from 'fumadocs-openapi/requests/generators/curl';
import { javascript } from 'fumadocs-openapi/requests/generators/javascript';
import { Callout } from 'fumadocs-ui/components/callout';
import type { ReactNode } from 'react';

/**
 * The API reference page for one relayer operation, rendered from the relayer
 * OpenAPI spec. The "try it" playground runs in the browser and calls the
 * selected server directly (the hosted testnet by default, the first server in
 * the spec); the relayer answers CORS for any origin.
 */

// Code samples: curl and fetch for every operation, plus the @bosphor/sdk call
// where the SDK wraps the route.
// The blob routes take raw file bytes, which the stock generators would render
// as a placeholder string, so those samples read the bytes from a file instead.
const RAW = 'application/octet-stream';
type RequestHeaders = Record<string, { value: unknown }>;

function headerLines(header: RequestHeaders): [string, string][] {
  return Object.entries(header).map(([k, v]) => [k, String(v.value)]);
}

const codeUsages = createCodeUsageGeneratorRegistry();
codeUsages.add('curl', {
  ...curl,
  generate(data, ctx) {
    if (data.bodyMediaType !== RAW) return curl.generate(data, ctx);
    return [
      `curl -X ${data.method.toUpperCase()} "${data.url}"`,
      ...headerLines(data.header).map(([k, v]) => `  -H "${k}: ${v}"`),
      `  -H "Content-Type: ${RAW}"`,
      '  --data-binary @./file.bin',
    ].join(' \\\n');
  },
});
codeUsages.add('js', {
  ...javascript,
  label: 'JavaScript (fetch)',
  generate(data, ctx) {
    if (data.bodyMediaType !== RAW) return javascript.generate(data, ctx);
    const headers = Object.fromEntries([...headerLines(data.header), ['Content-Type', RAW]]);
    return [
      '// The exact bytes you committed to, e.g. from a file input.',
      'const body = new Uint8Array(await file.arrayBuffer());',
      '',
      `const res = await fetch("${data.url}", {`,
      `  method: "${data.method.toUpperCase()}",`,
      `  headers: ${JSON.stringify(headers, null, 2).replace(/\n/g, '\n  ')},`,
      '  body,',
      '});',
      'console.log(res.status, await res.json());',
    ].join('\n');
  },
});

const sdkSamples: Record<string, string> = {
  createQuote: `import { TESTNET, fetchQuote } from '@bosphor/sdk';

// POST /quote. Amounts come back as bigint (wei or lamports).
const quote = await fetchQuote(
  TESTNET.relayerUrl,
  { sizeBytes: 1024, epochs: 5, originToken: 'ETH' },
  { appId: 'my-dapp' }, // optional X-Bosphor-App
);

console.log(quote.totalNative); // msg.value at submit`,
  ingestBlob: `import { createBosphorClientFromSigner } from '@bosphor/sdk/evm';

const client = await createBosphorClientFromSigner(signer); // hosted testnet

// store() submits the intent, then uploads the bytes with
// POST /blob/{intentId} for you, and waits for the storage proof.
const result = await client.store(data);

// Escape hatch: upload the bytes for an intent you submitted yourself.
await client.upload(intentId, data);`,
  encodeBlob: `import { TESTNET, relayerComputeBlob } from '@bosphor/sdk';

// POST /blob/encode, no Walrus WASM (SDK 0.14.0+). Clients take the
// shortcut computeBlob: 'relayer'. blobId is 0x hex here, ready for
// submitIntent; the relayer returns the same id base64url-encoded.
const computeBlob = relayerComputeBlob(TESTNET.relayerUrl, { appId: 'my-dapp' });
const { blobId, size } = await computeBlob(data);`,
  getSolanaLzFee: `import { TESTNET, fetchSolanaLzFee, quoteSolanaStore } from '@bosphor/sdk/solana';

// GET /lz-fee/solana (SDK 0.14.0+): the live fee in lamports, as a bigint.
const lamports = await fetchSolanaLzFee(TESTNET.relayerUrl);

// quoteSolanaStore() calls it for you when the LayerZero Solana SDK
// is not installed, so a browser quote is exact.
const quote = await quoteSolanaStore({ sizeBytes: 1024 });`,
};

type Notice = { type: 'info' | 'warn'; title: string; body: ReactNode };

const notices: Record<string, Notice> = {
  getHealth: {
    type: 'info',
    title: 'Try it works out of the box',
    body: 'Send the request to see the live health of the hosted testnet relayer.',
  },
  createQuote: {
    type: 'info',
    title: 'Try it works out of the box',
    body: 'The body is prefilled with an example. Pick another example above the code samples, or change the size and epochs, and send it to get a live testnet quote.',
  },
  getSolanaLzFee: {
    type: 'info',
    title: 'Needs relayer 0.17.0 or later',
    body: 'Send the request to get the live Solana devnet to Sui testnet LayerZero fee from the hosted testnet relayer; a relayer that predates the endpoint answers 404. One simulation is reused for 30 seconds.',
  },
  ingestBlob: {
    type: 'warn',
    title: 'Needs a real intent id',
    body: (
      <>
        The relayer only accepts bytes for an intent it has already seen on chain, and only
        when they match the committed blob id and size. With the example id it answers{' '}
        <code>404</code>. Submit an intent first (the SDK <code>store()</code> call does both
        steps), then upload its exact bytes once. Please do not use this console to send
        repeated or test uploads: the route shares a rate-limited budget with every other
        integrator on the hosted testnet.
      </>
    ),
  },
  encodeBlob: {
    type: 'warn',
    title: 'CPU heavy, tightly rate limited',
    body: 'Nothing is stored and no intent id is needed, but encoding is expensive for the relayer and has its own budget of 30 requests per minute per IP. Send a small body, once.',
  },
  listIntents: {
    type: 'info',
    title: 'Try it works out of the box',
    body: 'Returns the live intent feed of the hosted testnet relayer. Lower limit for a shorter response.',
  },
};

function NoticeCallout({ notice }: { notice: Notice }) {
  return (
    <Callout type={notice.type} title={notice.title} className="mt-0">
      {notice.body}
    </Callout>
  );
}

export const APIPage = createOpenAPIPage({
  storageKeyPrefix: 'bosphor-api-',
  codeUsages,
  generateCodeSamples({ operation }) {
    const sample = operation.operationId ? sdkSamples[operation.operationId] : undefined;
    return sample ? [{ id: 'sdk', lang: 'ts', label: '@bosphor/sdk', source: sample }] : [];
  },
  content: {
    renderOperationLayout(slots, { operation }) {
      const notice = operation.operationId ? notices[operation.operationId] : undefined;
      return (
        <div className="flex flex-col gap-x-6 gap-y-4 @4xl:flex-row @4xl:items-start">
          <div className="min-w-0 flex-1">
            {slots.header}
            {notice ? <NoticeCallout notice={notice} /> : null}
            {slots.apiPlayground}
            {slots.description}
            {slots.authSchemes}
            {slots.parameters}
            {slots.body}
            {slots.responses}
            {slots.callbacks}
          </div>
          <div className="@4xl:sticky @4xl:top-[calc(var(--fd-docs-row-1,2rem)+1rem)] @4xl:w-[400px]">
            {slots.apiExample}
          </div>
        </div>
      );
    },
  },
});
