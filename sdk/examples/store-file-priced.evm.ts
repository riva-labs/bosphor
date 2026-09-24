/**
 * Runnable example: PRICED store over the EVM path (the user-pays flow), on the
 * hosted Bosphor testnet.
 *
 * `storePriced()` fetches an all-in ETH quote from the relayer, pays the escrow
 * plus the LayerZero fee at submit, uploads the bytes, and awaits the proof that
 * releases the escrow to the relayer. If no proof lands before the deadline, the
 * payer can call `refund(intentId)` on the adapter.
 *
 * Not run in CI. Needs a Sepolia signer with ETH (a 1 KB store costs roughly
 * 0.0015 ETH plus gas at current prices) and the optional peers `ethers`,
 * `@mysten/walrus`, and `@mysten/sui`.
 *
 *   RPC_URL, PRIVATE_KEY, FILE
 *
 * Run: node --import tsx examples/store-file-priced.evm.ts
 */

import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { TESTNET, createBosphorClientFromSigner, walrusBlobUrl } from "@bosphor/sdk/evm";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

async function main(): Promise<void> {
  const provider = new ethers.JsonRpcProvider(env("RPC_URL"));
  const signer = new ethers.Wallet(env("PRIVATE_KEY"), provider);
  const client = await createBosphorClientFromSigner(signer);

  const data = new Uint8Array(readFileSync(env("FILE")));

  // Preview the quote before paying.
  const encoded = await client.encode(data, { epochs: 5 });
  const quote = await client.priceQuote(encoded);
  console.log("All-in quote:");
  console.log(`  escrow:   ${ethers.formatEther(quote.escrowNative)} ETH ($${quote.breakdown.escrowUsd.toFixed(4)})`);
  console.log(`  LZ fee:   ${ethers.formatEther(quote.forwardNative)} ETH`);
  console.log(`  total:    ${ethers.formatEther(quote.totalNative)} ETH ($${quote.breakdown.totalUsd.toFixed(4)})`);

  console.log(`Storing ${data.length} bytes via one storePriced() call...`);
  const result = await client.storePriced(data, { epochs: 5 });

  console.log("Stored, verified, and escrow released on proof:");
  console.log(`  intentId: ${result.intentId}`);
  console.log(`  blobId:   ${result.blobId}`);
  console.log(`  endEpoch: ${result.endEpoch}`);
  console.log(`  tx:       ${TESTNET.evm.explorerUrl}/tx/${result.txHash}`);
  console.log(`  blob:     ${walrusBlobUrl(result.blobId)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
