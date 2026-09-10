/**
 * LayerZero v2 PacketV1 decoder (Solana-side vendor).
 *
 * Vendored from /home/arb/bosphor-dvn/src/packet.ts (the proven EVM-return
 * decoder). Offsets match the canonical PacketV1Codec layout:
 *   [0]      version (u8, must be 1)
 *   [1..9]   nonce (u64 BE)
 *   [9..13]  srcEid (u32 BE)
 *   [13..45] sender (bytes32)
 *   [45..49] dstEid (u32 BE)
 *   [49..81] receiver (bytes32)
 *   [81..113] guid (bytes32)
 *   [113..]  message
 *
 * The Sui endpoint's `messaging_channel::PacketSentEvent.encoded_packet` is this
 * exact PacketV1 payload, so this handles a Sui->Solana return packet directly.
 *
 * Kept dependency-light (no ethers) so the Solana wiring toolchain does not pull
 * in an EVM stack: all parsing is done with Buffer + DataView.
 */

export interface LzPacket {
  version: number;
  nonce: bigint;
  srcEid: number;
  sender: string; // bytes32, 0x-prefixed hex
  dstEid: number;
  receiver: string; // bytes32, 0x-prefixed hex
  guid: string; // bytes32, 0x-prefixed hex
  message: string; // 0x-prefixed hex
  header: string; // first 81 bytes (version..receiver), 0x-prefixed hex
  payloadHash: string; // not used on Solana (endpoint recomputes); kept for parity
}

function toBuf(encodedPayload: string | Uint8Array | number[]): Buffer {
  if (typeof encodedPayload === "string") {
    const h = encodedPayload.startsWith("0x")
      ? encodedPayload.slice(2)
      : encodedPayload;
    return Buffer.from(h, "hex");
  }
  return Buffer.from(encodedPayload);
}

const hx = (b: Buffer): string => "0x" + b.toString("hex");

export function decodePacket(
  encodedPayload: string | Uint8Array | number[],
): LzPacket {
  const b = toBuf(encodedPayload);
  if (b.length < 113) throw new Error(`packet too short: ${b.length} bytes`);
  if (b[0] !== 1) throw new Error(`unsupported packet version ${b[0]}`);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const guid = b.subarray(81, 113);
  const message = b.subarray(113);
  return {
    version: b[0],
    nonce: dv.getBigUint64(1, false), // u64 BE
    srcEid: dv.getUint32(9, false), // u32 BE
    sender: hx(b.subarray(13, 45)),
    dstEid: dv.getUint32(45, false), // u32 BE
    receiver: hx(b.subarray(49, 81)),
    guid: hx(guid),
    message: hx(message),
    header: hx(b.subarray(0, 81)),
    // payloadHash on Solana is derived on-chain by the ULN from the packet
    // bytes; the worker never supplies it, so we leave it as the guid||message
    // concat's hex marker rather than a keccak (no ethers dep).
    payloadHash: hx(Buffer.concat([guid, message])),
  };
}

// Self-test: `tsx src/lz-packet.ts <encodedPayload-hex>`.
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: tsx src/lz-packet.ts <encodedPayload-hex>");
    process.exit(1);
  }
  const p = decodePacket(arg);
  console.log(JSON.stringify({ ...p, nonce: p.nonce.toString() }, null, 2));
}
