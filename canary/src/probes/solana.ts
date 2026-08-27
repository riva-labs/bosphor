import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { EndpointProgram, UlnProgram } from '@layerzerolabs/lz-solana-sdk-v2';
import { Options } from '@layerzerolabs/lz-v2-utilities';
import {
  createBosphorSolanaClient,
  createDefaultSolanaChain,
  defaultComputeBlob,
} from '@bosphor/sdk/solana';
import { uploadWithRetry } from '../upload.ts';
import type { ChainProbe, PreflightOutcome } from '../probe.ts';

/**
 * Solana origin probe. Drives one real `encode -> submit -> upload -> awaitProof`
 * round-trip per tick through the `@bosphor/sdk` Solana client. The heavy Solana
 * and LayerZero SDKs are static imports here, so this module is loaded lazily by
 * `main.ts` only when Solana is configured, keeping the EVM-only canary light.
 *
 * The LayerZero endpoint `send` accounts are deployment-specific; the SDK does
 * not synthesize them. We assemble them once at startup with the LZ Solana SDK
 * (exactly as `scripts/solana/submit-intent.ts` does) and feed them to the
 * default backend, along with a 400k compute-unit budget for the endpoint CPI.
 */
export interface SolanaProbeConfig {
  rpcUrl: string;
  programId: string;
  /** Keypair as a JSON secret-key array (inline) or a path to one. */
  keypair: string;
  relayerUrl: string;
  /** Destination LayerZero endpoint id (Sui testnet is 40378). */
  dstEid: number;
  /** Sui receiver bytes32 (0x hex) that the forward packet targets. */
  suiReceiver: string;
  storageEpochs: number;
  /** Native fee (lamports) attached for the LayerZero `send` CPI. */
  nativeFee: bigint;
  /** Compute-unit limit for submit_intent (the endpoint CPI needs ~400k). */
  computeUnitLimit: number;
  /** Preflight guard: skip when the sender is below this many SOL. */
  minBalanceSol: number;
  /** LayerZero v2 endpoint program id (base58). */
  endpointId: string;
  /** LayerZero v2 ULN302 message library program id (base58). */
  ulnId: string;
}

const STORE_SEED = Buffer.from('store');

function storePda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([STORE_SEED], programId)[0];
}

/** Load a keypair from an inline JSON secret-key array or a file path. */
function loadKeypair(spec: string): Keypair {
  const trimmed = spec.trim();
  const raw = trimmed.startsWith('[')
    ? trimmed
    : readFileSync(trimmed.replace(/^~/, homedir()), 'utf8');
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

export async function createSolanaProbe(cfg: SolanaProbeConfig): Promise<ChainProbe> {
  const connection = new Connection(cfg.rpcUrl, 'confirmed');
  const payer = loadKeypair(cfg.keypair);
  const programId = new PublicKey(cfg.programId);
  const store = storePda(programId);

  // Assemble the LayerZero `send` CPI accounts once: they are deterministic per
  // pathway (sender = Store PDA, dstEid, receiver). The LZ SDK bundles its own
  // @solana/web3.js, so normalize returned pubkeys to our copy to avoid mixing
  // two PublicKey classes during serialization.
  const endpoint = new EndpointProgram.Endpoint(new PublicKey(cfg.endpointId));
  const uln = new UlnProgram.Uln(new PublicKey(cfg.ulnId));
  const path = {
    sender: '0x' + Buffer.from(store.toBytes()).toString('hex'),
    dstEid: cfg.dstEid,
    receiver: cfg.suiReceiver,
  };
  const rawSend = (await endpoint.getSendIXAccountMetaForCPI(
    connection as never,
    payer.publicKey as never,
    path,
    uln,
    'confirmed',
  )) as Array<{ pubkey: { toBase58(): string }; isSigner: boolean; isWritable: boolean }>;
  const endpointAccounts = rawSend.map((a) => ({
    pubkey: new PublicKey(a.pubkey.toBase58()),
    isSigner: a.isSigner,
    isWritable: a.isWritable,
  }));

  const options =
    '0x' +
    Buffer.from(Options.newOptions().addExecutorLzReceiveOption(200_000, 0).toBytes()).toString(
      'hex',
    );

  const chain = await createDefaultSolanaChain({
    connection,
    wallet: payer,
    programId: cfg.programId,
    endpointAccounts,
    computeUnitLimit: cfg.computeUnitLimit,
  });

  const client = createBosphorSolanaClient({
    chain,
    relayerUrl: cfg.relayerUrl,
    dstEid: cfg.dstEid,
    options: options as `0x${string}`,
    nativeFee: cfg.nativeFee,
    defaultEpochs: cfg.storageEpochs,
    computeBlob: defaultComputeBlob,
  });

  return {
    chain: 'solana',
    label: `${payer.publicKey.toBase58()} -> Sui(${cfg.dstEid})`,

    async preflight(): Promise<PreflightOutcome> {
      let sol = NaN;
      try {
        sol = (await connection.getBalance(payer.publicKey)) / 1e9;
      } catch {
        // transient RPC error; leave balance unknown for this tick
      }
      const low = Number.isFinite(sol) && sol < cfg.minBalanceSol;
      return { ok: !low, reason: low ? 'low_balance' : undefined, balanceNative: sol };
    },

    async submit(): Promise<{ intentId: string }> {
      const data = new TextEncoder().encode(`bosphor-canary-solana-${Date.now()}`);
      const encoded = await client.encode(data);
      const { intentId } = await client.submit(encoded);
      // Retry past the relayer's IntentSubmitted watch lag (404 until registered).
      await uploadWithRetry((id, d) => client.upload(id as `0x${string}`, d), intentId, data);
      return { intentId };
    },

    async awaitProof(intentId: string, maxWaitMs: number): Promise<void> {
      await client.awaitProof(intentId as `0x${string}`, { timeoutMs: maxWaitMs });
    },
  };
}
