/**
 * Upload the blob bytes for a real-blob Solana intent to the relayer's ingest
 * endpoint, after the forward leg has delivered (IntentReceived on Sui). The
 * relayer recomputes the blob id, verifies it matches the commitment, stores to
 * Walrus, and runs execute_store (M3 #242).
 *
 * Reads /tmp/solana-rt.json written by `submit-intent` in DATA mode.
 *
 *   RELAYER_URL=http://localhost:3456 npm run roundtrip-upload
 */

import { readFileSync } from "node:fs";

const RELAYER_URL = process.env.RELAYER_URL ?? "http://localhost:3456";

async function main(): Promise<void> {
  const rt = JSON.parse(readFileSync("/tmp/solana-rt.json", "utf8")) as {
    intentId: string;
    blobId: string;
    size: number;
    dataB64: string;
  };
  const data = Buffer.from(rt.dataB64, "base64");
  const url = `${RELAYER_URL}/blob/${rt.intentId}`;
  console.log("intentId:", rt.intentId);
  console.log("blobId:  ", rt.blobId);
  console.log("POST     ", url, `(${data.length} bytes)`);

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: data,
  });
  const text = await res.text();
  console.log(`-> ${res.status} ${res.statusText}: ${text}`);
  if (!res.ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
