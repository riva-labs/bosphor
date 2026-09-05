import { parseIrisAttestation, IrisAttestationClient } from './iris-client';
import complete from './fixtures/iris-complete.json';
import pending from './fixtures/iris-pending.json';

describe('parseIrisAttestation (canned Iris JSON)', () => {
  it('parses a completed attestation', () => {
    const a = parseIrisAttestation(complete);
    expect(a.status).toBe('complete');
    expect(a.attestation).toMatch(/^0x/);
    expect(a.eventNonce).toBe('2748');
  });

  it('reports pending without fabricating an attestation', () => {
    const a = parseIrisAttestation(pending);
    expect(a.status).toBe('pending');
    expect(a.attestation).toBeNull();
  });

  it('fails loud on a malformed response', () => {
    expect(() => parseIrisAttestation({})).toThrow(/no messages/);
    expect(() => parseIrisAttestation({ messages: [{}] })).toThrow(/missing required fields/);
  });

  it('works behind the IrisAttestationClient interface with a mock', async () => {
    const mock: IrisAttestationClient = {
      getAttestation: async () => parseIrisAttestation(complete),
    };
    const a = await mock.getAttestation(0, '0xabc');
    expect(a.status).toBe('complete');
  });
});
