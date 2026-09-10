/**
 * Cost-per-blob-size curve generator for the M4 status report (deliverable c).
 *
 * Prints a markdown table of the all-in quote for a range of blob sizes on both
 * the EVM (ETH) and Solana (SOL) origins, using the pure WalCostCalculator +
 * QuoteEngine. Prices default to a representative set; override via env for a
 * live snapshot. Not a test; a documentation artifact.
 *
 * Run: npx tsx scripts/cost-curve.ts
 */
import { computeWalCost, WalrusSystemState } from '../src/walrus/wal-cost.calculator';
import { QuoteEngine, QuoteConfig, OriginToken } from '../src/pricing/quote-engine';
import { PriceSet } from '../src/pricing/price-oracle.types';

const STATE: WalrusSystemState = {
  nShards: 1000,
  storagePricePerUnitSize: 100_000n,
  writePricePerUnitSize: 20_000n,
  encodingType: 'RS2',
};

const PRICES: PriceSet = {
  WAL: { token: 'WAL', usd: Number(process.env.WAL_USD ?? 0.03), publishTimeMs: 0, source: 'sim' },
  SUI: { token: 'SUI', usd: Number(process.env.SUI_USD ?? 0.8), publishTimeMs: 0, source: 'sim' },
  ETH: { token: 'ETH', usd: Number(process.env.ETH_USD ?? 2500), publishTimeMs: 0, source: 'sim' },
  SOL: { token: 'SOL', usd: Number(process.env.SOL_USD ?? 100), publishTimeMs: 0, source: 'sim' },
};

const CONFIG: QuoteConfig = {
  buffers: { returnLeg: 0.2, suiGas: 0.2, wal: 0.1, crossRate: 0.05 },
  serviceMarginRatio: 0.15,
  minChargeUsd: 0.02,
};

const RETURN_LZ_MIST = 1_760_000_000n;
const SUI_GAS_MIST = 10_000_000n;
const EPOCHS = 5;
const SIZES: Array<[string, number]> = [
  ['1 KiB', 1024],
  ['64 KiB', 64 * 1024],
  ['1 MiB', 1024 * 1024],
  ['5 MiB', 5 * 1024 * 1024],
  ['10 MiB', 10 * 1024 * 1024],
];

function row(label: string, size: number, originToken: OriginToken): string {
  const engine = new QuoteEngine(CONFIG);
  const wal = computeWalCost(size, EPOCHS, STATE);
  const q = engine.quote(
    {
      originToken,
      walCostFrost: wal.totalCostFrost,
      returnLzFeeMist: RETURN_LZ_MIST,
      suiGasMist: SUI_GAS_MIST,
      forwardLzFeeNative: 0n,
      originGasNative: 0n,
    },
    PRICES,
  );
  const b = q.breakdown;
  return `| ${label} | ${wal.storageUnits} | $${b.walCostUsd.toFixed(5)} | $${b.escrowUsd.toFixed(4)} | ${q.escrowNative} |`;
}

function main(): void {
  console.log(
    `Prices: WAL $${PRICES.WAL.usd}, SUI $${PRICES.SUI.usd}, ETH $${PRICES.ETH.usd}, SOL $${PRICES.SOL.usd}\n`,
  );
  for (const originToken of ['ETH', 'SOL'] as OriginToken[]) {
    const unit = originToken === 'ETH' ? 'wei' : 'lamports';
    console.log(`### ${originToken} origin (escrow bucket)\n`);
    console.log(`| Blob size | WAL units | WAL cost | Escrow (USD) | Escrow (${unit}) |`);
    console.log('|-----------|-----------|----------|--------------|----------------|');
    for (const [label, size] of SIZES) console.log(row(label, size, originToken));
    console.log('');
  }
}

main();
