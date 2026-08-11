//! Bosphor CommitmentCodec: the Rust reference for the Solana adapter.
//!
//! This is the fourth implementation of the single Bosphor intent commitment wire
//! format (after TypeScript, Solidity, and Move) and is pinned byte for byte to the
//! same shared parity vectors (`shared/parity/commitment-vectors.json`).
//!
//! Canonical commitment layout (49 bytes, big-endian):
//!   blob_id(32) ++ size(u32) ++ encoding_type(u8) ++ storage_epochs(u32) ++ deadline(u64)
//!
//! Storage is committed as a duration (`storage_epochs`), never an absolute end
//! epoch, because origin chains do not know the current Walrus epoch.
//!
//! intentId derivation:
//!   keccak256( commitment(49) ++ sender(32, left-padded big-endian) ++ nonce(u64) )
//!
//! `keccak256` is vendored (see [`keccak`]) so the crate is dependency-free and
//! builds offline. A Solana program can substitute `solana_program::keccak::hash`,
//! which produces identical output.

pub const COMMITMENT_LEN: usize = 49;
pub const BLOB_ID_LEN: usize = 32;
/// Canonical sender width in the intentId preimage (big-endian, left-padded).
pub const SENDER_LEN: usize = 32;

/// A Bosphor storage commitment referencing a Walrus blob and its storage terms.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Commitment {
    /// 32-byte Walrus blob id.
    pub blob_id: [u8; BLOB_ID_LEN],
    /// Blob size in bytes.
    pub size: u32,
    /// Walrus encoding type discriminant.
    pub encoding_type: u8,
    /// Committed storage duration in Walrus epochs.
    pub storage_epochs: u32,
    /// Intent deadline as unix seconds.
    pub deadline: u64,
}

/// Encodes a commitment into its canonical 49-byte big-endian representation.
pub fn encode(c: &Commitment) -> [u8; COMMITMENT_LEN] {
    let mut out = [0u8; COMMITMENT_LEN];
    out[0..32].copy_from_slice(&c.blob_id);
    out[32..36].copy_from_slice(&c.size.to_be_bytes());
    out[36] = c.encoding_type;
    out[37..41].copy_from_slice(&c.storage_epochs.to_be_bytes());
    out[41..49].copy_from_slice(&c.deadline.to_be_bytes());
    out
}

/// Errors returned when decoding a commitment.
#[derive(Debug, PartialEq, Eq)]
pub enum DecodeError {
    /// The input was not exactly [`COMMITMENT_LEN`] bytes.
    InvalidLength(usize),
}

/// Decodes a canonical 49-byte commitment. Inverse of [`encode`].
pub fn decode(bytes: &[u8]) -> Result<Commitment, DecodeError> {
    if bytes.len() != COMMITMENT_LEN {
        return Err(DecodeError::InvalidLength(bytes.len()));
    }
    let mut blob_id = [0u8; BLOB_ID_LEN];
    blob_id.copy_from_slice(&bytes[0..32]);
    Ok(Commitment {
        blob_id,
        size: u32::from_be_bytes(bytes[32..36].try_into().unwrap()),
        encoding_type: bytes[36],
        storage_epochs: u32::from_be_bytes(bytes[37..41].try_into().unwrap()),
        deadline: u64::from_be_bytes(bytes[41..49].try_into().unwrap()),
    })
}

/// Derives the canonical, chain-agnostic intentId:
///   keccak256( commitment(49) ++ sender(32, left-padded big-endian) ++ nonce(u64) )
///
/// `sender` may be shorter than 32 bytes (e.g. a 20-byte EVM address); it is
/// left-padded with zeros so EVM, Sui, and Solana senders derive uniformly.
///
/// # Panics
/// Panics if `sender` is longer than 32 bytes.
pub fn derive_intent_id(c: &Commitment, sender: &[u8], nonce: u64) -> [u8; 32] {
    assert!(sender.len() <= SENDER_LEN, "sender must be <= 32 bytes");
    let mut preimage = [0u8; COMMITMENT_LEN + SENDER_LEN + 8];
    preimage[0..COMMITMENT_LEN].copy_from_slice(&encode(c));
    let sender_start = COMMITMENT_LEN + (SENDER_LEN - sender.len());
    preimage[sender_start..COMMITMENT_LEN + SENDER_LEN].copy_from_slice(sender);
    preimage[COMMITMENT_LEN + SENDER_LEN..].copy_from_slice(&nonce.to_be_bytes());
    keccak::keccak256(&preimage)
}

/// Vendored keccak256 (Ethereum/Walrus keccak, 0x01 padding), dependency-free.
pub mod keccak {
    const ROUND_CONSTANTS: [u64; 24] = [
        0x0000000000000001, 0x0000000000008082, 0x800000000000808a, 0x8000000080008000,
        0x000000000000808b, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
        0x000000000000008a, 0x0000000000000088, 0x0000000080008009, 0x000000008000000a,
        0x000000008000808b, 0x800000000000008b, 0x8000000000008089, 0x8000000000008003,
        0x8000000000008002, 0x8000000000000080, 0x000000000000800a, 0x800000008000000a,
        0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
    ];
    const ROTATIONS: [u32; 24] =
        [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];
    const PI_LANES: [usize; 24] =
        [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];

    fn keccak_f1600(state: &mut [u64; 25]) {
        let mut bc = [0u64; 5];
        for round in 0..24 {
            // Theta
            for i in 0..5 {
                bc[i] = state[i] ^ state[i + 5] ^ state[i + 10] ^ state[i + 15] ^ state[i + 20];
            }
            for i in 0..5 {
                let t = bc[(i + 4) % 5] ^ bc[(i + 1) % 5].rotate_left(1);
                let mut j = 0;
                while j < 25 {
                    state[j + i] ^= t;
                    j += 5;
                }
            }
            // Rho and Pi
            let mut t = state[1];
            for i in 0..24 {
                let j = PI_LANES[i];
                let tmp = state[j];
                state[j] = t.rotate_left(ROTATIONS[i]);
                t = tmp;
            }
            // Chi
            let mut j = 0;
            while j < 25 {
                for i in 0..5 {
                    bc[i] = state[j + i];
                }
                for i in 0..5 {
                    state[j + i] ^= (!bc[(i + 1) % 5]) & bc[(i + 2) % 5];
                }
                j += 5;
            }
            // Iota
            state[0] ^= ROUND_CONSTANTS[round];
        }
    }

    /// Computes the keccak256 digest of `input`.
    pub fn keccak256(input: &[u8]) -> [u8; 32] {
        const RATE: usize = 136; // 1088-bit rate for keccak256
        let mut state = [0u64; 25];

        let mut offset = 0;
        while input.len() - offset >= RATE {
            absorb_block(&mut state, &input[offset..offset + RATE]);
            keccak_f1600(&mut state);
            offset += RATE;
        }

        // Final block with pad10*1 (keccak domain byte 0x01, terminator 0x80).
        let mut block = [0u8; RATE];
        let rem = input.len() - offset;
        block[..rem].copy_from_slice(&input[offset..]);
        block[rem] ^= 0x01;
        block[RATE - 1] ^= 0x80;
        absorb_block(&mut state, &block);
        keccak_f1600(&mut state);

        let mut out = [0u8; 32];
        for i in 0..4 {
            out[i * 8..i * 8 + 8].copy_from_slice(&state[i].to_le_bytes());
        }
        out
    }

    fn absorb_block(state: &mut [u64; 25], block: &[u8]) {
        for (i, lane) in state.iter_mut().take(block.len() / 8).enumerate() {
            let mut v = 0u64;
            for b in 0..8 {
                v |= (block[i * 8 + b] as u64) << (8 * b);
            }
            *lane ^= v;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(s: &str) -> Vec<u8> {
        assert!(s.len() % 2 == 0);
        (0..s.len() / 2)
            .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap())
            .collect()
    }

    fn h32(s: &str) -> [u8; 32] {
        h(s).try_into().unwrap()
    }

    #[test]
    fn keccak256_empty_matches_known_answer() {
        // keccak256("") is a fixed, well-known value.
        assert_eq!(
            hex(&keccak::keccak256(&[])),
            "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
        );
    }

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{:02x}", x)).collect()
    }

    // The full cross-chain parity vectors run as a generated integration test in
    // tests/parity_vectors.rs (single source of truth: shared/parity/commitment-vectors.json).

    #[test]
    fn decode_is_inverse_of_encode() {
        let c = Commitment {
            blob_id: h32(&"11".repeat(32)),
            size: 0x0102_0304,
            encoding_type: 0xab,
            storage_epochs: 5,
            deadline: 1_760_000_000,
        };
        assert_eq!(decode(&encode(&c)).unwrap(), c);
    }

    #[test]
    fn decode_rejects_wrong_length() {
        assert_eq!(decode(&[0u8; 48]), Err(DecodeError::InvalidLength(48)));
    }
}
