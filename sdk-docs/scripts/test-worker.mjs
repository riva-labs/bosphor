// Unit tests for the redirect Worker. Run: node --test scripts/test-worker.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handle } from '../worker/index.mjs';
import { legacyDocsSite, legacySdkSite } from '../redirects/map.mjs';

const assets = {
  fetch: async (req) => new Response(`asset:${new URL(req.url).pathname}`, { status: 200 }),
};

const get = (url, env = { ASSETS: assets }) => handle(new Request(url), env);

test('every old docs.bosphor.xyz page 301s to its new page', async () => {
  for (const [from, to] of Object.entries(legacyDocsSite)) {
    for (const variant of [from, `${from}/`]) {
      const res = await get(`https://docs.bosphor.xyz${variant}`);
      assert.equal(res.status, 301, variant);
      assert.equal(res.headers.get('location'), `https://docs.bosphor.xyz${to}`, variant);
    }
  }
});

test('every moved sdk.bosphor.xyz page 301s on the same host', async () => {
  for (const [from, to] of Object.entries(legacySdkSite)) {
    const res = await get(`https://sdk.bosphor.xyz${from}`);
    assert.equal(res.status, 301, from);
    assert.equal(res.headers.get('location'), `https://sdk.bosphor.xyz${to}`, from);
  }
});

test('query strings are kept', async () => {
  const res = await get('https://docs.bosphor.xyz/quickstart?utm_source=x');
  assert.equal(res.headers.get('location'), 'https://docs.bosphor.xyz/docs/quickstart?utm_source=x');
});

test('pages that did not move are served from assets', async () => {
  for (const p of ['/', '/docs', '/docs/quickstart', '/docs/reference/core', '/llms.txt', '/_next/x.js']) {
    const res = await get(`https://docs.bosphor.xyz${p}`);
    assert.equal(res.status, 200, p);
    assert.equal(await res.text(), `asset:${p}`);
  }
});

test('CANONICAL_ORIGIN moves other hosts to the canonical host, mapping old paths', async () => {
  const env = { ASSETS: assets, CANONICAL_ORIGIN: 'https://docs.bosphor.xyz' };
  let res = await get('https://sdk.bosphor.xyz/docs/evm', env);
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), 'https://docs.bosphor.xyz/docs/guides/evm');

  res = await get('https://sdk.bosphor.xyz/docs/reference/core', env);
  assert.equal(res.headers.get('location'), 'https://docs.bosphor.xyz/docs/reference/core');

  res = await get('https://docs.bosphor.xyz/docs/reference/core', env);
  assert.equal(res.status, 200);
});
