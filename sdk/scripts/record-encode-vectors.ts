/**
 * Record `POST /blob/encode` responses from a live relayer next to the local
 * `@mysten/walrus` (WASM) blob id for the same bytes, for the parity fixture in
 * `src/relayer-blob.test.ts`. Encode-only: the relayer stores nothing.
 *
 *   node --import tsx scripts/record-encode-vectors.ts [relayerUrl]
 */
import { createDefaultComputeBlob } from "../src/blob.js";
import { ENCODE_PARITY_INPUTS } from "../src/relayer-blob.fixtures.js";

const relayerUrl = process.argv[2] ?? "https://api.bosphor.xyz/testnet";
const wasm = createDefaultComputeBlob("testnet");

const out: Array<{ name: string; relayerBlobId: string; size: number; wasmBlobId: string }> = [];
for (const input of ENCODE_PARITY_INPUTS) {
  const bytes = input.bytes();
  const res = await fetch(`${relayerUrl}/blob/encode`, {
    method: "POST",
    body: bytes,
    headers: { "content-type": "application/octet-stream", "X-Bosphor-App": "bosphor-sdk-tests" },
  });
  const body = (await res.json()) as { blobId: string; size: number };
  if (!res.ok) throw new Error(`encode failed (${res.status}): ${JSON.stringify(body)}`);
  const local = await wasm(bytes);
  out.push({ name: input.name, relayerBlobId: body.blobId, size: body.size, wasmBlobId: local.blobId });
}
console.log(JSON.stringify(out, null, 2));
