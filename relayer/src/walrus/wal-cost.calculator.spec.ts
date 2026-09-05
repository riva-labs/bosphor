import { computeWalCost, WalrusSystemState } from './wal-cost.calculator';

// Live-anchored mainnet-style prices (docs): 100000 FROST/unit/epoch storage,
// 20000 FROST/unit write. RedStuff/RS2 uses 1000 shards on Walrus.
const STATE: WalrusSystemState = {
  nShards: 1000,
  storagePricePerUnitSize: 100_000n,
  writePricePerUnitSize: 20_000n,
  encodingType: 'RS2',
};

describe('computeWalCost', () => {
  // Encoded sizes and storage units are cross-checked against the Walrus SDK's
  // own encodedBlobLength()/storageUnitsFromSize() for these exact inputs.
  it('computes the per-blob metadata floor for a 1-byte blob', () => {
    const r = computeWalCost(1, 5, STATE);
    expect(r.encodedSize).toBe(66_034_000);
    expect(r.storageUnits).toBe(63);
    // 63 units * 100000 * 5 epochs
    expect(r.storageCostFrost).toBe(63n * 100_000n * 5n);
    // 63 units * 20000
    expect(r.writeCostFrost).toBe(63n * 20_000n);
    expect(r.totalCostFrost).toBe(63n * 100_000n * 5n + 63n * 20_000n);
  });

  it('treats sub-symbol blobs the same as the floor (1 KiB == 1 byte)', () => {
    const r = computeWalCost(1024, 5, STATE);
    expect(r.encodedSize).toBe(66_034_000);
    expect(r.storageUnits).toBe(63);
  });

  it('computes a 1 MiB blob above the floor', () => {
    const r = computeWalCost(1024 * 1024, 5, STATE);
    expect(r.encodedSize).toBe(70_038_000);
    expect(r.storageUnits).toBe(67);
    expect(r.storageCostFrost).toBe(67n * 100_000n * 5n);
    expect(r.totalCostFrost).toBe(67n * 100_000n * 5n + 67n * 20_000n);
  });

  it('computes a 10 MiB blob', () => {
    const r = computeWalCost(10 * 1024 * 1024, 5, STATE);
    expect(r.encodedSize).toBe(112_080_000);
    expect(r.storageUnits).toBe(107);
  });

  it('scales storage cost linearly with epochs', () => {
    const one = computeWalCost(1024 * 1024, 1, STATE);
    const ten = computeWalCost(1024 * 1024, 10, STATE);
    expect(ten.storageCostFrost).toBe(one.storageCostFrost * 10n);
    // write cost is a one-off, independent of epochs
    expect(ten.writeCostFrost).toBe(one.writeCostFrost);
  });

  it('carries through the inputs in the breakdown', () => {
    const r = computeWalCost(1024 * 1024, 5, STATE);
    expect(r.unencodedSize).toBe(1024 * 1024);
    expect(r.epochs).toBe(5);
  });

  describe('fails loud on unknown / invalid input (never a fabricated cost)', () => {
    it('rejects a negative size', () => {
      expect(() => computeWalCost(-1, 5, STATE)).toThrow(/size/i);
    });
    it('rejects a non-integer size', () => {
      expect(() => computeWalCost(1.5, 5, STATE)).toThrow(/size/i);
    });
    it('rejects a non-finite size', () => {
      expect(() => computeWalCost(Number.NaN, 5, STATE)).toThrow(/size/i);
    });
    it('rejects zero epochs', () => {
      expect(() => computeWalCost(1024, 0, STATE)).toThrow(/epoch/i);
    });
    it('rejects zero shards', () => {
      expect(() => computeWalCost(1024, 5, { ...STATE, nShards: 0 })).toThrow(/shard/i);
    });
    it('rejects a negative storage price', () => {
      expect(() =>
        computeWalCost(1024, 5, { ...STATE, storagePricePerUnitSize: -1n }),
      ).toThrow(/price/i);
    });
    it('rejects a missing write price', () => {
      expect(() =>
        computeWalCost(1024, 5, {
          ...STATE,
          writePricePerUnitSize: undefined as unknown as bigint,
        }),
      ).toThrow(/price/i);
    });
  });
});
