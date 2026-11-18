import { test } from "node:test";
import assert from "node:assert/strict";
import * as web3 from "@solana/web3.js";
import type { PublicKey } from "@solana/web3.js";
import type {
  MessageSignerWalletAdapterProps,
  SignerWalletAdapterProps,
  SignInMessageSignerWalletAdapterProps,
  WalletAdapterProps,
  WalletName,
} from "@solana/wallet-adapter-base";
import { createDefaultSolanaChain, type DefaultSolanaChainOptions } from "./backend.js";
import type { CreateSolanaClientFromKeypairOptions } from "./endpoint-accounts.js";

/**
 * Faithful structural copy of `WalletContextState` from
 * `@solana/wallet-adapter-react` 0.15 (`useWallet()`), built on the real
 * signer types of `@solana/wallet-adapter-base`. Copied instead of depending on
 * the React package, which would pull React into the SDK's dev tree.
 */
interface WalletContextState {
  autoConnect: boolean;
  wallets: unknown[];
  wallet: unknown | null;
  publicKey: PublicKey | null;
  connecting: boolean;
  connected: boolean;
  disconnecting: boolean;
  select(walletName: WalletName | null): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendTransaction: WalletAdapterProps["sendTransaction"];
  signTransaction: SignerWalletAdapterProps["signTransaction"] | undefined;
  signAllTransactions: SignerWalletAdapterProps["signAllTransactions"] | undefined;
  signMessage: MessageSignerWalletAdapterProps["signMessage"] | undefined;
  signIn: SignInMessageSignerWalletAdapterProps["signIn"] | undefined;
}

// Compile-time checks: `wallet: useWallet()` must type-check under strict TS.
// These lines fail `tsc` (npm run typecheck) if the accepted wallet type narrows.
type Assert<T extends true> = T;
type Accepts<Target, Source> = [Source] extends [Target] ? true : false;
export type _FactoryAcceptsUseWallet = Assert<
  Accepts<CreateSolanaClientFromKeypairOptions["wallet"], WalletContextState>
>;
export type _BackendAcceptsUseWallet = Assert<
  Accepts<DefaultSolanaChainOptions["wallet"], WalletContextState>
>;

function useWalletLike(over: Partial<WalletContextState>): WalletContextState {
  const kp = web3.Keypair.generate();
  return {
    autoConnect: false,
    wallets: [],
    wallet: null,
    publicKey: kp.publicKey,
    connecting: false,
    connected: true,
    disconnecting: false,
    select: () => {},
    connect: async () => {},
    disconnect: async () => {},
    sendTransaction: async () => "sig",
    signTransaction: async (tx) => tx,
    signAllTransactions: async (txs) => txs,
    signMessage: undefined,
    signIn: undefined,
    ...over,
  };
}

test("a connected useWallet() state is accepted as the wallet", async () => {
  const chain = await createDefaultSolanaChain({ connection: {}, wallet: useWalletLike({}), web3 });
  assert.equal(typeof chain.submitIntent, "function");
});

test("a disconnected useWallet() state fails with a clear error", async () => {
  await assert.rejects(
    createDefaultSolanaChain({ connection: {}, wallet: useWalletLike({ publicKey: null }), web3 }),
    /not connected/,
  );
});

test("a wallet that cannot sign transactions fails with a clear error", async () => {
  await assert.rejects(
    createDefaultSolanaChain({
      connection: {},
      wallet: useWalletLike({ signTransaction: undefined }),
      web3,
    }),
    /cannot sign transactions/,
  );
});
