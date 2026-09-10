/**
 * Pure Walrus storage-cost calculator.
 *
 * Given an unencoded blob size, a storage duration in epochs, and a live Walrus
 * system state (shard count + FROST prices), it computes the RedStuff-encoded
 * blob length, the number of billed storage units, and the exact FROST cost.
 *
 * The encoding math mirrors the Walrus SDK's own encodedBlobLength() /
 * storageUnitsFromSize() (see @mysten/walrus/dist/utils) so a cost computed here
 * matches what writeBlob() will actually pay. It is deliberately dependency-free
 * and side-effect-free so it can be unit-tested exhaustively and reused by the
 * quote engine. It never fabricates a value: any invalid input throws.
 *
 * IMPORTANT: the caller MUST pass a system state read from fresh on-chain state
 * (never a cached price across an epoch boundary). This module does no caching.
 */

export type WalrusEncodingType = 'RS2' | 'RedStuff';

export interface WalrusSystemState {
  /** Number of committee shards (committee.n_shards). Walrus uses 1000. */
  nShards: number;
  /** FROST charged per storage unit per epoch. */
  storagePricePerUnitSize: bigint;
  /** FROST charged per storage unit as a one-off write fee. */
  writePricePerUnitSize: bigint;
  /** Encoding scheme. Defaults to RS2 (RedStuff v2), what writeBlob uses. */
  encodingType?: WalrusEncodingType;
}

export interface WalCostBreakdown {
  /** The size passed in, in bytes. */
  unencodedSize: number;
  /** The RedStuff-encoded length in bytes (includes the metadata floor). */
  encodedSize: number;
  /** Billed storage units (encoded size rounded up to 1 MiB units). */
  storageUnits: number;
  /** Storage duration this cost covers. */
  epochs: number;
  /** FROST for storage over the given epochs. */
  storageCostFrost: bigint;
  /** One-off write FROST (epoch-independent). */
  writeCostFrost: bigint;
  /** storageCostFrost + writeCostFrost. */
  totalCostFrost: bigint;
}

const DIGEST_LEN = 32;
const BLOB_ID_LEN = 32;
const BYTES_PER_UNIT_SIZE = 1024 * 1024;

function getMaxFaultyNodes(nShards: number): number {
  return Math.floor((nShards - 1) / 3);
}

function decodingSafetyLimit(nShards: number, encodingType: WalrusEncodingType): number {
  switch (encodingType) {
    case 'RedStuff':
      return Math.min(5, Math.floor(getMaxFaultyNodes(nShards) / 5));
    case 'RS2':
      return 0;
    default:
      throw new Error(`Unknown Walrus encoding type: ${encodingType}`);
  }
}

function getSourceSymbols(
  nShards: number,
  encodingType: WalrusEncodingType,
): { primarySymbols: number; secondarySymbols: number } {
  const safetyLimit = decodingSafetyLimit(nShards, encodingType);
  const maxFaulty = getMaxFaultyNodes(nShards);
  const minCorrect = nShards - maxFaulty;
  return {
    primarySymbols: minCorrect - maxFaulty - safetyLimit,
    secondarySymbols: minCorrect - safetyLimit,
  };
}

function encodedSliverSize(
  unencodedLength: number,
  nShards: number,
  encodingType: WalrusEncodingType,
): number {
  const { primarySymbols, secondarySymbols } = getSourceSymbols(nShards, encodingType);
  let symbolSize =
    Math.floor((Math.max(unencodedLength, 1) - 1) / (primarySymbols * secondarySymbols)) + 1;
  if (encodingType === 'RS2' && symbolSize % 2 === 1) symbolSize += 1;
  return (primarySymbols + secondarySymbols) * symbolSize * nShards;
}

function encodedBlobLength(
  unencodedLength: number,
  nShards: number,
  encodingType: WalrusEncodingType,
): number {
  const sliverSize = encodedSliverSize(unencodedLength, nShards, encodingType);
  return nShards * (nShards * DIGEST_LEN * 2 + BLOB_ID_LEN) + sliverSize;
}

function storageUnitsFromSize(encodedSize: number): number {
  return Math.ceil(encodedSize / BYTES_PER_UNIT_SIZE);
}

/**
 * Compute the exact WAL storage cost (in FROST) for a blob.
 *
 * @param unencodedSize raw blob size in bytes (>= 0, integer)
 * @param epochs number of epochs to store for (>= 1, integer)
 * @param state live Walrus system state (shards + FROST prices)
 * @throws if any input is invalid, so an unknown cost never silently reads as zero
 */
export function computeWalCost(
  unencodedSize: number,
  epochs: number,
  state: WalrusSystemState,
): WalCostBreakdown {
  if (!Number.isInteger(unencodedSize) || unencodedSize < 0) {
    throw new Error(`Invalid blob size: ${unencodedSize} (must be a non-negative integer)`);
  }
  if (!Number.isInteger(epochs) || epochs < 1) {
    throw new Error(`Invalid epochs: ${epochs} (must be a positive integer)`);
  }
  if (!Number.isInteger(state.nShards) || state.nShards < 1) {
    throw new Error(`Invalid shard count: ${state.nShards} (must be a positive integer)`);
  }
  const { storagePricePerUnitSize, writePricePerUnitSize } = state;
  if (typeof storagePricePerUnitSize !== 'bigint' || storagePricePerUnitSize < 0n) {
    throw new Error(`Invalid storage price: ${storagePricePerUnitSize}`);
  }
  if (typeof writePricePerUnitSize !== 'bigint' || writePricePerUnitSize < 0n) {
    throw new Error(`Invalid write price: ${writePricePerUnitSize}`);
  }

  const encodingType = state.encodingType ?? 'RS2';
  const encodedSize = encodedBlobLength(unencodedSize, state.nShards, encodingType);
  const storageUnits = storageUnitsFromSize(encodedSize);

  const storageCostFrost = BigInt(storageUnits) * storagePricePerUnitSize * BigInt(epochs);
  const writeCostFrost = BigInt(storageUnits) * writePricePerUnitSize;

  return {
    unencodedSize,
    encodedSize,
    storageUnits,
    epochs,
    storageCostFrost,
    writeCostFrost,
    totalCostFrost: storageCostFrost + writeCostFrost,
  };
}
