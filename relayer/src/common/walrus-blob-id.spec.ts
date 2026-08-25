import { blobIdToInt } from '@mysten/walrus';
import { walrusBlobIdToField, fieldToWalrusBlobId, blobIdMatches } from './walrus-blob-id';

// Real Walrus testnet blob ids. blobIdToInt is Walrus's own decode of the base64url
// string into the u256 that on-chain `blob.blob_id()` returns.
const IDS = [
  'qineIE9eC8z5CTaTsILV-LL_8VwRVCK-lKZftG7B4ik',
  'C8PS3IT9ICqfchEnlef3gJfjLGm3clG-_tQp87R_hUM',
];

describe('walrusBlobIdToField', () => {
  it('encodes the Walrus blob-id u256 big-endian (matches @mysten/walrus ground truth)', () => {
    for (const id of IDS) {
      const field = walrusBlobIdToField(id);
      const asBigEndianU256 = BigInt('0x' + field.toString('hex'));
      // The canonical field read big-endian must equal Walrus's u256, i.e. exactly
      // what Sui's bytes32_to_u256 will compare against blob.blob_id().
      expect(asBigEndianU256).toBe(blobIdToInt(id));
    }
  });

  it('rejects ids that are not 32 bytes', () => {
    expect(() => walrusBlobIdToField('AAAA')).toThrow(/32-byte Walrus blob id/);
  });
});

describe('fieldToWalrusBlobId', () => {
  it('is the inverse of walrusBlobIdToField (round-trips the aggregator id)', () => {
    for (const id of IDS) {
      const committedHex = '0x' + walrusBlobIdToField(id).toString('hex');
      // Recovering the aggregator id from the commitment must return the original.
      expect(fieldToWalrusBlobId(committedHex)).toBe(id);
    }
  });

  it('rejects a commitment that is not 32 bytes', () => {
    expect(() => fieldToWalrusBlobId('0x1234')).toThrow(/32-byte commitment/);
  });
});

describe('blobIdMatches', () => {
  it('accepts a recomputed id against its canonical big-endian commitment', () => {
    for (const id of IDS) {
      const committedHex = '0x' + blobIdToInt(id).toString(16).padStart(64, '0');
      expect(blobIdMatches(id, committedHex)).toBe(true);
    }
  });

  it('rejects a mismatched commitment', () => {
    const committedHex = '0x' + blobIdToInt(IDS[1]).toString(16).padStart(64, '0');
    expect(blobIdMatches(IDS[0], committedHex)).toBe(false);
  });

  it('rejects the pre-fix little-endian (raw base64url) bytes', () => {
    // Guards against regressing to the old bug: the raw base64url bytes (no reversal)
    // must NOT match the canonical big-endian commitment.
    const rawLittleEndianHex = '0x' + Buffer.from(IDS[0], 'base64url').toString('hex');
    expect(blobIdMatches(IDS[0], rawLittleEndianHex)).toBe(false);
  });
});
