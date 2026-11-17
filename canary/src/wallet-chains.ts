import { readFileSync } from 'fs';
import { ethers } from 'ethers';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction, coinWithBalance } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction as SolanaTransaction,
  clusterApiUrl,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { SUI_COIN_TYPE, type WalletChain, type WatchedWallet } from './wallet-config.ts';

/** A funded wallet the watcher may draw testnet top-ups from. */
export interface Treasury {
  address: string;
  /** Never draw the treasury below this, whole tokens. */
  floor: number;
  /** Send `amount` whole native tokens to `to`. Resolves with the tx id once confirmed. */
  send(to: string, amount: number): Promise<string>;
}

/** Everything the watcher needs from one chain. Injected so the watcher is testable. */
export interface ChainAdapter {
  chain: WalletChain;
  /** Network the RPC actually serves, from its chain identity (not from config). */
  detectNetwork(): Promise<string>;
  /** Balance in whole tokens. Throws on a failed read; never returns a placeholder. */
  readBalance(w: Pick<WatchedWallet, 'address' | 'coinType' | 'decimals'>): Promise<number>;
  treasury?: Treasury;
}

/** Base units for a whole-token amount, rounded down so we never overspend. */
function toBaseUnits(amount: number, decimals: number): bigint {
  const fixed = amount.toFixed(decimals + 2);
  const [whole, frac = ''] = fixed.split('.');
  return ethers.parseUnits(`${whole}.${frac.slice(0, decimals)}`, decimals);
}

// --- Sui -------------------------------------------------------------------

// gRPC reports the genesis checkpoint digest (base58); JSON-RPC used its first
// 4 bytes in hex. Accept both. Anything unknown is treated as not-a-testnet.
const SUI_CHAIN_IDS: Record<string, string> = {
  '69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD': 'testnet',
  '4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S': 'mainnet',
  '4c78adac': 'testnet',
  '35834a8a': 'mainnet',
};

function suiKeypair(key: string): Ed25519Keypair {
  if (!key.startsWith('suiprivkey')) throw new Error('SUI_TREASURY_KEY must be a suiprivkey1... string');
  const { scheme, secretKey } = decodeSuiPrivateKey(key);
  if (scheme !== 'ED25519') throw new Error(`SUI_TREASURY_KEY: unsupported key scheme ${scheme}`);
  return Ed25519Keypair.fromSecretKey(secretKey);
}

export function createSuiAdapter(opts: {
  network: string;
  grpcUrl?: string;
  treasuryKey?: string;
  treasuryFloor?: number;
}): ChainAdapter {
  const baseUrl = opts.grpcUrl || `https://fullnode.${opts.network}.sui.io:443`;
  const client = new SuiGrpcClient({
    network: opts.network as 'testnet' | 'mainnet' | 'devnet',
    baseUrl,
  });
  const adapter: ChainAdapter = {
    chain: 'sui',
    async detectNetwork() {
      const { chainIdentifier } = await client.core.getChainIdentifier();
      return SUI_CHAIN_IDS[chainIdentifier] ?? `unknown-${chainIdentifier}`;
    },
    async readBalance(w) {
      // totalBalance covers coin objects AND the address balance.
      const { balance } = await client.core.getBalance({
        owner: w.address,
        coinType: w.coinType ?? SUI_COIN_TYPE,
      });
      return Number(ethers.formatUnits(BigInt(balance.balance), w.decimals));
    },
  };
  if (opts.treasuryKey) {
    const kp = suiKeypair(opts.treasuryKey);
    adapter.treasury = {
      address: kp.toSuiAddress(),
      floor: requireFloor(opts.treasuryFloor, 'SUI_TREASURY_FLOOR'),
      async send(to, amount) {
        const tx = new Transaction();
        tx.setSender(kp.toSuiAddress());
        // coinWithBalance draws from coin objects and the address balance alike.
        tx.transferObjects([coinWithBalance({ balance: toBaseUnits(amount, 9) })], to);
        const bytes = await tx.build({ client });
        const { signature } = await kp.signTransaction(bytes);
        const res = await client.core.executeTransaction({ transaction: bytes, signatures: [signature] });
        if (res.$kind === 'FailedTransaction') {
          throw new Error(`Sui top-up failed: ${JSON.stringify(res.FailedTransaction.status)}`);
        }
        await client.core.waitForTransaction({ digest: res.Transaction.digest });
        return res.Transaction.digest;
      },
    };
  }
  return adapter;
}

// --- EVM -------------------------------------------------------------------

const EVM_CHAIN_IDS: Record<string, string> = { '11155111': 'sepolia', '1': 'mainnet' };

export function createEvmAdapter(opts: {
  rpcUrl: string;
  treasuryKey?: string;
  treasuryFloor?: number;
}): ChainAdapter {
  const provider = new ethers.JsonRpcProvider(opts.rpcUrl);
  const adapter: ChainAdapter = {
    chain: 'evm',
    async detectNetwork() {
      const { chainId } = await provider.getNetwork();
      return EVM_CHAIN_IDS[chainId.toString()] ?? `chain-${chainId}`;
    },
    async readBalance(w) {
      return Number(ethers.formatUnits(await provider.getBalance(w.address), w.decimals));
    },
  };
  if (opts.treasuryKey) {
    const wallet = new ethers.Wallet(opts.treasuryKey, provider);
    adapter.treasury = {
      address: wallet.address,
      floor: requireFloor(opts.treasuryFloor, 'EVM_TREASURY_FLOOR'),
      async send(to, amount) {
        const tx = await wallet.sendTransaction({ to, value: toBaseUnits(amount, 18) });
        const receipt = await tx.wait(1);
        if (!receipt || receipt.status !== 1) throw new Error(`EVM top-up reverted: ${tx.hash}`);
        return tx.hash;
      },
    };
  }
  return adapter;
}

// --- Solana ----------------------------------------------------------------

const SOLANA_GENESIS: Record<string, string> = {
  EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG: 'devnet',
  '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY': 'testnet',
  '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d': 'mainnet',
};

function loadSolanaKeypair(spec: string): Keypair {
  const raw = spec.trim().startsWith('[') ? spec : readFileSync(spec, 'utf8');
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

export function createSolanaAdapter(opts: {
  network: string;
  rpcUrl?: string;
  treasuryKeypair?: string;
  treasuryFloor?: number;
}): ChainAdapter {
  const rpcUrl =
    opts.rpcUrl || clusterApiUrl(opts.network === 'testnet' ? 'testnet' : opts.network === 'devnet' ? 'devnet' : 'mainnet-beta');
  const conn = new Connection(rpcUrl, 'confirmed');
  const adapter: ChainAdapter = {
    chain: 'solana',
    async detectNetwork() {
      const genesis = await conn.getGenesisHash();
      return SOLANA_GENESIS[genesis] ?? `unknown-${genesis}`;
    },
    async readBalance(w) {
      const lamports = await conn.getBalance(new PublicKey(w.address));
      return Number(ethers.formatUnits(BigInt(lamports), w.decimals));
    },
  };
  if (opts.treasuryKeypair) {
    const payer = loadSolanaKeypair(opts.treasuryKeypair);
    adapter.treasury = {
      address: payer.publicKey.toBase58(),
      floor: requireFloor(opts.treasuryFloor, 'SOLANA_TREASURY_FLOOR'),
      async send(to, amount) {
        const tx = new SolanaTransaction().add(
          SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: new PublicKey(to),
            lamports: toBaseUnits(amount, 9),
          }),
        );
        return sendAndConfirmTransaction(conn, tx, [payer]);
      },
    };
  }
  return adapter;
}

/** A treasury without an explicit floor is a config error: fail at startup, never guess. */
function requireFloor(floor: number | undefined, name: string): number {
  if (floor === undefined || !Number.isFinite(floor) || floor < 0) {
    throw new Error(`${name} must be set (non-negative, whole tokens) when its treasury key is set`);
  }
  return floor;
}
