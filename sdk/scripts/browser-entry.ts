/**
 * A sample browser dApp entry, bundled by `src/browser-bundle.test.ts` to prove
 * the SDK bundles for the browser: EVM and Solana with injected modules, blob
 * ids through the relayer, and the relayer's live Solana LayerZero fee. It must
 * need no Node built-in and must not pull `@mysten/walrus` or the LayerZero SDK.
 */
import * as ethers from "ethers";
import * as web3 from "@solana/web3.js";
import { TESTNET, relayerComputeBlob, RelayerRequestError } from "../src/index.js";
import { createBosphorClientFromSigner, quoteEvmStore } from "../src/evm/index.js";
import {
  createBosphorSolanaClientFromWallet,
  fetchSolanaLzFee,
  quoteSolanaStore,
} from "../src/solana/index.js";

export async function evmStore(eip1193: unknown, bytes: Uint8Array) {
  const signer = await new ethers.BrowserProvider(eip1193 as never).getSigner();
  const client = await createBosphorClientFromSigner(signer, {
    ethers,
    computeBlob: "relayer",
    appId: "my-dapp",
  });
  return client.storePriced(bytes);
}

export function evmQuote() {
  const provider = new ethers.JsonRpcProvider(TESTNET.evm.rpcUrl);
  return quoteEvmStore({ provider, sizeBytes: 1024, ethers });
}

export async function solanaStore(wallet: never, bytes: Uint8Array) {
  const connection = new web3.Connection(TESTNET.solana.rpcUrl, "confirmed");
  const client = await createBosphorSolanaClientFromWallet({
    connection,
    wallet,
    web3,
    computeBlob: "relayer",
  });
  return client.storePriced(bytes);
}

export async function solanaQuote() {
  return [await quoteSolanaStore({ sizeBytes: 1024, web3 }), await fetchSolanaLzFee(TESTNET.relayerUrl)];
}

export const blob = relayerComputeBlob(TESTNET.relayerUrl);
export { RelayerRequestError };
