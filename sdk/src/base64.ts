/**
 * Runtime-agnostic base64 decoding, with no dependency on Node's `Buffer`.
 *
 * `atob` is a web standard available in Node 18+ and every browser, so the core
 * codec stays portable: an EVM or codec-only consumer never needs a `Buffer`
 * polyfill to compute a blob id or parse an event.
 */

/** Decode standard base64 to bytes. */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Decode URL-safe base64 (base64url) to bytes. */
export function base64UrlToBytes(base64url: string): Uint8Array {
  return base64ToBytes(base64url.replace(/-/g, "+").replace(/_/g, "/"));
}
