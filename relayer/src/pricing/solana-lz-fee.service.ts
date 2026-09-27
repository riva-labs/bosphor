import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  quoteSolanaLzFeeLamports,
  type SolanaLzFeeDeps,
  type SolanaLzFeePath,
} from './solana-lz-fee';

/** A live Solana -> Sui LayerZero fee, as served by `GET /lz-fee/solana`. */
export interface SolanaLzFeeQuote {
  /** LayerZero native fee in lamports for one Bosphor forward message. */
  nativeFee: bigint;
  /** Solana LayerZero endpoint id (origin). */
  srcEid: number;
  /** Sui LayerZero endpoint id (destination). */
  dstEid: number;
  /** When the fee was simulated (unix ms). */
  quotedAtMs: number;
  /** How long the relayer reuses one simulation (ms). */
  maxAgeMs: number;
}

/** Test seams; production uses the real Solana stack and clock. */
export interface SolanaLzFeeHooks {
  loadDeps: () => SolanaLzFeeDeps;
  quote: (deps: SolanaLzFeeDeps, path: SolanaLzFeePath) => Promise<bigint>;
  now: () => number;
}

export const SOLANA_LZ_FEE_HOOKS = Symbol('SOLANA_LZ_FEE_HOOKS');

/** Seconds a failed simulation is remembered, and the Retry-After clients get. */
export const SOLANA_LZ_FEE_RETRY_AFTER_SECONDS = 5;

/** The live fee is unavailable right now; retry after `retryAfterSeconds`. */
export class SolanaLzFeeUnavailableError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super(message);
    this.name = 'SolanaLzFeeUnavailableError';
  }
}

/**
 * Computes the live Solana -> Sui LayerZero fee server-side, so a browser can
 * price a Solana store without bundling `@layerzerolabs/lz-solana-sdk-v2`. One
 * read-only simulation is reused for SOLANA_LZ_FEE_CACHE_MS (30s) and shared by
 * concurrent callers. A failure is thrown to the caller and remembered for
 * SOLANA_LZ_FEE_RETRY_AFTER_SECONDS, during which callers get the same error
 * without a new simulation. No stale or default fee is ever served.
 */
@Injectable()
export class SolanaLzFeeService {
  private readonly hooks: SolanaLzFeeHooks;
  private deps?: SolanaLzFeeDeps;
  private cached?: SolanaLzFeeQuote;
  private inflight?: Promise<SolanaLzFeeQuote>;
  private failure?: { message: string; untilMs: number };

  constructor(
    private readonly config: ConfigService,
    @Optional() @Inject(SOLANA_LZ_FEE_HOOKS) hooks?: Partial<SolanaLzFeeHooks>,
  ) {
    this.hooks = {
      loadDeps: hooks?.loadDeps ?? (() => this.loadRealDeps()),
      quote: hooks?.quote ?? quoteSolanaLzFeeLamports,
      now: hooks?.now ?? Date.now,
    };
  }

  /** Enabled when the Solana origin (RPC + program) and the Sui peer are configured. */
  isEnabled(): boolean {
    return Boolean(
      this.config.get<string>('SOLANA_RPC_URL') &&
      this.config.get<string>('SOLANA_PROGRAM_ID') &&
      this.config.get<string>('SOLANA_LZ_SUI_PEER'),
    );
  }

  /** Destination (Sui) endpoint id this relayer prices. */
  get dstEid(): number {
    return Number(this.config.get<number>('SUI_EID'));
  }

  /** The live fee, from cache when younger than the TTL. Throws on any failure. */
  async quote(): Promise<SolanaLzFeeQuote> {
    if (!this.isEnabled()) {
      throw new Error('Solana LayerZero fee quoting is not enabled on this relayer');
    }
    const now = this.hooks.now();
    if (this.cached && now - this.cached.quotedAtMs < this.cached.maxAgeMs) return this.cached;
    // A recent failure is answered from memory until its retry window ends, so an
    // RPC outage does not turn every request into more RPC calls. Still an error:
    // no stale or default fee is served in its place.
    if (this.failure && now < this.failure.untilMs) {
      throw new SolanaLzFeeUnavailableError(
        this.failure.message,
        Math.max(1, Math.ceil((this.failure.untilMs - now) / 1000)),
      );
    }
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async refresh(): Promise<SolanaLzFeeQuote> {
    try {
      const quote = await this.simulate();
      this.failure = undefined;
      return quote;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.failure = {
        message,
        untilMs: this.hooks.now() + SOLANA_LZ_FEE_RETRY_AFTER_SECONDS * 1000,
      };
      throw new SolanaLzFeeUnavailableError(message, SOLANA_LZ_FEE_RETRY_AFTER_SECONDS);
    }
  }

  private async simulate(): Promise<SolanaLzFeeQuote> {
    this.deps ??= this.hooks.loadDeps();
    const path: SolanaLzFeePath = {
      programId: this.config.get<string>('SOLANA_PROGRAM_ID')!,
      endpointProgram: this.config.get<string>('SOLANA_LZ_ENDPOINT_PROGRAM')!,
      ulnProgram: this.config.get<string>('SOLANA_LZ_ULN_PROGRAM')!,
      dstEid: this.dstEid,
      receiver: this.config.get<string>('SOLANA_LZ_SUI_PEER')!,
      options: this.config.get<string>('SOLANA_LZ_OPTIONS')!,
    };
    const nativeFee = await this.hooks.quote(this.deps, path);
    const quote: SolanaLzFeeQuote = {
      nativeFee,
      srcEid: Number(this.config.get<number>('SOLANA_SRC_EID')),
      dstEid: path.dstEid,
      quotedAtMs: this.hooks.now(),
      maxAgeMs: Number(this.config.get<number>('SOLANA_LZ_FEE_CACHE_MS', 30_000)),
    };
    this.cached = quote;
    return quote;
  }

  /**
   * Load the Solana stack on first use only, so relayers without Solana (and
   * unit tests) never pay for the heavy LayerZero SDK import.
   */
  private loadRealDeps(): SolanaLzFeeDeps {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const web3 = require('@solana/web3.js');
    const lz = require('@layerzerolabs/lz-solana-sdk-v2');
    /* eslint-enable @typescript-eslint/no-require-imports */
    const connection = new web3.Connection(this.config.get<string>('SOLANA_RPC_URL')!, 'confirmed');
    return { connection, web3, lz };
  }
}
