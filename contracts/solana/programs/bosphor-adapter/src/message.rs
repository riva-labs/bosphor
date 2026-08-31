//! Cross-chain wire formats for the Bosphor OApp, byte-compatible with the EVM,
//! Sui, and TypeScript implementations so the Solana <-> Sui round-trip is
//! interoperable.
//!
//! Forward leg (Solana -> Sui), 82 bytes:
//!   `intentId(32) ++ commitment(50)`
//! where `commitment` is the canonical 50-byte version-1 encoding from
//! `bosphor_commitment_codec` (version ++ blobId ++ size ++ encodingType ++
//! storageEpochs ++ deadline). This is exactly what the Sui `lz_receive` parses.
//!
//! Return leg (Sui -> Solana), 97 bytes, type-1 proof:
//!   `[0x01] ++ intentId(32) ++ blobId(32) ++ endEpoch(u256 big-endian, 32)`
//! matching `sui/lz-receiver/sources/codec.move`. `endEpoch` is a 32-byte
//! big-endian uint256; the low 8 bytes are taken as the `u64` end epoch.

use bosphor_commitment_codec::{encode, Commitment, COMMITMENT_LEN};

/// Length of the forward-leg message: intentId(32) ++ commitment(50).
pub const FORWARD_MESSAGE_LEN: usize = 32 + COMMITMENT_LEN; // 82

/// Length of the return-leg type-1 proof message.
pub const PROOF_MESSAGE_LEN: usize = 97;

/// Type byte for the return-leg proof (message type 1).
pub const PROOF_TYPE_1: u8 = 0x01;

/// Builds the 82-byte forward message `intentId(32) ++ commitment(50)`.
pub fn encode_forward(intent_id: &[u8; 32], commitment: &Commitment) -> Vec<u8> {
    let mut out = Vec::with_capacity(FORWARD_MESSAGE_LEN);
    out.extend_from_slice(intent_id);
    out.extend_from_slice(&encode(commitment));
    out
}

/// Decoded fields of a return-leg type-1 proof.
#[derive(Debug, PartialEq, Eq)]
pub struct DecodedProof {
    pub intent_id: [u8; 32],
    pub blob_id: [u8; 32],
    pub end_epoch: u64,
}

/// Errors from decoding a return proof.
#[derive(Debug, PartialEq, Eq)]
pub enum ProofError {
    /// Message was not exactly [`PROOF_MESSAGE_LEN`] bytes.
    InvalidLength(usize),
    /// First byte was not [`PROOF_TYPE_1`].
    InvalidType(u8),
}

/// Decodes a 97-byte type-1 proof into its components.
///
/// `endEpoch` is encoded as a big-endian uint256; the low 8 bytes (offset 89..97)
/// are taken as the `u64` end epoch, mirroring the Sui/EVM decoders.
pub fn decode_proof(message: &[u8]) -> Result<DecodedProof, ProofError> {
    if message.len() != PROOF_MESSAGE_LEN {
        return Err(ProofError::InvalidLength(message.len()));
    }
    if message[0] != PROOF_TYPE_1 {
        return Err(ProofError::InvalidType(message[0]));
    }
    let mut intent_id = [0u8; 32];
    intent_id.copy_from_slice(&message[1..33]);
    let mut blob_id = [0u8; 32];
    blob_id.copy_from_slice(&message[33..65]);
    // endEpoch: bytes 65..97 is a big-endian u256; take the low 8 bytes.
    let end_epoch = u64::from_be_bytes(message[89..97].try_into().unwrap());
    Ok(DecodedProof { intent_id, blob_id, end_epoch })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forward_message_is_82_bytes_and_layout_correct() {
        let intent_id = [7u8; 32];
        let c = Commitment {
            blob_id: [9u8; 32],
            size: 0x0102_0304,
            encoding_type: 0xab,
            storage_epochs: 5,
            deadline: 1_760_000_000,
        };
        let msg = encode_forward(&intent_id, &c);
        assert_eq!(msg.len(), FORWARD_MESSAGE_LEN);
        assert_eq!(&msg[0..32], &intent_id);
        assert_eq!(&msg[32..], &encode(&c));
    }

    #[test]
    fn proof_round_trips_end_epoch_low_8_bytes() {
        let mut m = [0u8; PROOF_MESSAGE_LEN];
        m[0] = PROOF_TYPE_1;
        let intent_id = [0x11u8; 32];
        let blob_id = [0x22u8; 32];
        m[1..33].copy_from_slice(&intent_id);
        m[33..65].copy_from_slice(&blob_id);
        // end_epoch = 0xDEAD_BEEF in the low 8 bytes of the trailing u256.
        m[89..97].copy_from_slice(&0xDEAD_BEEFu64.to_be_bytes());
        let d = decode_proof(&m).unwrap();
        assert_eq!(d.intent_id, intent_id);
        assert_eq!(d.blob_id, blob_id);
        assert_eq!(d.end_epoch, 0xDEAD_BEEF);
    }

    #[test]
    fn proof_rejects_bad_length_and_type() {
        assert_eq!(decode_proof(&[0u8; 96]), Err(ProofError::InvalidLength(96)));
        let mut m = [0u8; PROOF_MESSAGE_LEN];
        m[0] = 0x02;
        assert_eq!(decode_proof(&m), Err(ProofError::InvalidType(0x02)));
    }
}
