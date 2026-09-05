/**
 * CCTP (Circle Iris) attestation client + parser (scaffolding; live wiring deferred).
 *
 * The USDC settlement rail completes off-chain: after the source burn, the relayer
 * polls Circle's Iris service for the attestation, then mints on the destination
 * domain. This module owns the interface and the response parsing so the flow is
 * structured and testable now, behind a swappable client. The parser never
 * fabricates a value: a malformed response throws, and a not-yet-attested message
 * reports `pending` explicitly rather than silently looking complete.
 */

/** A completed or pending CCTP attestation for one burned message. */
export interface IrisAttestation {
  status: 'complete' | 'pending';
  message: string;
  eventNonce: string;
  /** The attestation bytes when complete; null while pending. */
  attestation: string | null;
}

/** Swappable Iris client. Live impl hits the Iris HTTP API; tests inject a mock. */
export interface IrisAttestationClient {
  /** Fetch the attestation for a burn tx on a source domain. */
  getAttestation(sourceDomain: number, txHash: string): Promise<IrisAttestation>;
}

interface IrisMessage {
  message?: string;
  eventNonce?: string;
  attestation?: string;
  status?: string;
}

/**
 * Parse an Iris `/v2/messages/{domain}` response body into an IrisAttestation.
 * Fails loud on a shape it does not recognise.
 */
export function parseIrisAttestation(body: unknown): IrisAttestation {
  const messages = (body as { messages?: IrisMessage[] })?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('Iris response has no messages');
  }
  const m = messages[0];
  if (typeof m.message !== 'string' || typeof m.eventNonce !== 'string') {
    throw new Error('Iris message is missing required fields (message/eventNonce)');
  }
  const complete = m.status === 'complete' && typeof m.attestation === 'string' && m.attestation.startsWith('0x');
  return {
    status: complete ? 'complete' : 'pending',
    message: m.message,
    eventNonce: m.eventNonce,
    attestation: complete ? (m.attestation as string) : null,
  };
}
