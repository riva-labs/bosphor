/**
 * Parity inputs for the relayer blob encoder, shared by the unit test and the
 * recorder script (`scripts/record-encode-vectors.ts`). Test-only: not part of
 * the published build.
 */

/** Deterministic byte patterns covering tiny, text and multi-KiB blobs. */
export const ENCODE_PARITY_INPUTS: ReadonlyArray<{ name: string; bytes: () => Uint8Array }> = [
  { name: "one zero byte", bytes: () => new Uint8Array([0]) },
  { name: "hello", bytes: () => new TextEncoder().encode("hello") },
  {
    name: "bosphor sentence",
    bytes: () => new TextEncoder().encode("Bosphor: making permanence portable."),
  },
  { name: "4 KiB ramp", bytes: () => Uint8Array.from({ length: 4096 }, (_, i) => i % 256) },
];
