import {
  decodeIntentSubmitted,
  parseIntentSubmittedEvents,
  INTENT_SUBMITTED_DISC,
} from './solana-intent.codec';

// Ground-truth `IntentSubmitted` event, captured live from the Bosphor Solana
// adapter on devnet (program 7RCSzaG9..., the proven real-blob round-trip intent
// 0xbce25e9c...). This pins the decoder to the on-chain program: a wire-format
// drift on either side fails here rather than in production.
const REAL_EVENT_B64 =
  'zmTnjfUeUGO84l6cm5u+48BscfIl453dwaxkjEDMDjv5mWS5wRAZhZq1X5nEcnFiea0SftzEbX5ZUSr' +
  'CbxjgcfVrTNOBGvt5AgAAAAAAAACGzRFhKK+Z0pYAHvqqUac9d+x+Atua+DThzQT0IcCflTMAAAAABQAA' +
  'AFpihWoAAAAAup0AAOavAaaiQ2PQE1WnBgw9SN7hiIzcwde5rhI56gak1eO5AwAAAAAAAAA=';

describe('decodeIntentSubmitted', () => {
  it('decodes the real on-chain IntentSubmitted event', () => {
    const bytes = Uint8Array.from(Buffer.from(REAL_EVENT_B64, 'base64'));
    const ev = decodeIntentSubmitted(bytes);

    expect(ev).not.toBeNull();
    expect(ev!.intentId).toBe(
      '0xbce25e9c9b9bbee3c06c71f225e39dddc1ac648c40cc0e3bf99964b9c1101985',
    );
    expect(ev!.committedBlobId).toBe(
      '0x86cd116128af99d296001efaaa51a73d77ec7e02db9af834e1cd04f421c09f95',
    );
    expect(ev!.size).toBe(51);
    expect(ev!.encodingType).toBe(0);
    expect(ev!.storageEpochs).toBe(5);
    expect(ev!.deadline).toBe(1787126362n);
    expect(ev!.dstEid).toBe(40378);
    // Solana submitter pubkey (32 bytes), not a Sui address.
    expect(Buffer.from(ev!.sender).toString('hex')).toBe(
      '9ab55f99c472716279ad127edcc46d7e59512ac26f18e071f56b4cd3811afb79',
    );
  });

  it('returns null for a non-IntentSubmitted payload (wrong discriminator)', () => {
    const bytes = new Uint8Array(8 + 165);
    bytes.set(Uint8Array.from(Buffer.from('b32fee483453bce3', 'hex')), 0); // IntentExecuted disc
    expect(decodeIntentSubmitted(bytes)).toBeNull();
  });

  it('returns null for a truncated payload', () => {
    const full = Uint8Array.from(Buffer.from(REAL_EVENT_B64, 'base64'));
    expect(decodeIntentSubmitted(full.subarray(0, 40))).toBeNull();
  });
});

describe('parseIntentSubmittedEvents', () => {
  it('extracts events from Anchor Program data log lines', () => {
    const logs = [
      'Program 7RCSzaG9NsK2BNMmLqQ22Zqrf6Te6Wvi5MNpknoit1AF invoke [1]',
      'Program log: Instruction: SubmitIntent',
      `Program data: ${REAL_EVENT_B64}`,
      'Program 7RCSzaG9NsK2BNMmLqQ22Zqrf6Te6Wvi5MNpknoit1AF success',
    ];
    const events = parseIntentSubmittedEvents(logs);
    expect(events).toHaveLength(1);
    expect(events[0].intentId).toBe(
      '0xbce25e9c9b9bbee3c06c71f225e39dddc1ac648c40cc0e3bf99964b9c1101985',
    );
  });

  it('ignores log lines without an IntentSubmitted event', () => {
    const logs = [
      'Program log: Instruction: InitStore',
      'Program data: AAAA', // not an IntentSubmitted event
      'Program log: success',
    ];
    expect(parseIntentSubmittedEvents(logs)).toEqual([]);
  });

  it('exposes the pinned event discriminator', () => {
    expect(INTENT_SUBMITTED_DISC).toBe('ce64e78df51e5063');
  });
});
