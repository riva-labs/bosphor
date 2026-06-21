import { ethers } from 'ethers';

/**
 * Everything the probe needs from the outside world. Network calls and the
 * clock are injected so the round-trip logic can be unit-tested without a chain.
 */
export interface ProbeDeps {
  sender: string;
  dstEid: number;
  options: string;
  deadlineSecondsFromNow: number;
  pollIntervalMs: number;
  maxWaitMs: number;
  buildPayload(): Uint8Array;
  getNonce(sender: string): Promise<bigint>;
  quoteFee(dstEid: number, payload: Uint8Array, deadline: number, options: string): Promise<bigint>;
  submitIntent(
    dstEid: number,
    payload: Uint8Array,
    deadline: number,
    options: string,
    value: bigint,
  ): Promise<void>;
  isExecuted(intentId: string): Promise<boolean>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface ProbeResult {
  success: boolean;
  intentId: string;
  roundtripSeconds?: number;
  submitSeconds?: number;
  returnSeconds?: number;
  failedStage?: 'submit' | 'return';
  error?: string;
}

/**
 * Deterministic intent id, matching the EVM adapter's
 * keccak256(abi.encodePacked(sender, dstEid, payload, nonce, deadline)).
 */
export function computeIntentId(
  sender: string,
  dstEid: number,
  payload: Uint8Array,
  nonce: bigint,
  deadline: number,
): string {
  return ethers.keccak256(
    ethers.solidityPacked(
      ['address', 'uint64', 'bytes', 'uint256', 'uint256'],
      [sender, dstEid, payload, nonce, deadline],
    ),
  );
}

/**
 * Submit one synthetic intent and track it to executed=true on EVM, timing the
 * submit leg and the return leg. Returns a structured result; never throws.
 */
export async function runProbe(deps: ProbeDeps): Promise<ProbeResult> {
  const t0 = deps.now();
  const payload = deps.buildPayload();
  const deadline = Math.floor(t0 / 1000) + deps.deadlineSecondsFromNow;
  let intentId = '';
  let submitSeconds = 0;

  try {
    const nonce = await deps.getNonce(deps.sender);
    intentId = computeIntentId(deps.sender, deps.dstEid, payload, nonce, deadline);
    const fee = await deps.quoteFee(deps.dstEid, payload, deadline, deps.options);
    const submitStart = deps.now();
    await deps.submitIntent(deps.dstEid, payload, deadline, deps.options, fee);
    submitSeconds = (deps.now() - submitStart) / 1000;
  } catch (err) {
    return { success: false, intentId, failedStage: 'submit', error: String(err) };
  }

  const pollStart = deps.now();
  while (deps.now() - pollStart < deps.maxWaitMs) {
    let executed = false;
    try {
      executed = await deps.isExecuted(intentId);
    } catch {
      // transient RPC error, retry on the next cycle
    }
    if (executed) {
      return {
        success: true,
        intentId,
        roundtripSeconds: (deps.now() - t0) / 1000,
        submitSeconds,
        returnSeconds: (deps.now() - pollStart) / 1000,
      };
    }
    await deps.sleep(deps.pollIntervalMs);
  }

  return { success: false, intentId, failedStage: 'return', error: 'timeout', submitSeconds };
}
