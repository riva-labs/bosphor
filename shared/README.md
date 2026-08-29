# shared/

Cross-language artifacts that belong to no single package and must be consumed
identically by every implementation. Kept at the repo root so no one chain
appears to "own" them.

## parity/commitment-vectors.json

The canonical parity oracle for the M3 CommitmentCodec: the wire format
(`blobId(32) ++ size(u32) ++ encodingType(u8) ++ storageEpochs(u32) ++
deadline(u64)`, big-endian), the `intentId` derivation
(`keccak256(commitment ++ sender ++ nonce)`), and a set of test vectors.

Every language implementation checks against these vectors and asserts
byte-for-byte agreement, so the commitment encoding can never drift across
chains. Some read the JSON directly; others consume a language file the
generator emits from it:

- TypeScript SDK: `sdk/src/parity.test.ts` (reads the JSON)
- Solidity / Forge: `contracts/evm/test/CommitmentCodec.t.sol` (reads the JSON via `vm.readFile`)
- Rust / Anchor (Solana): `contracts/solana/commitment-codec/` (`tests/parity_vectors.rs`)
- Move (Sui): `contracts/sui/lz-receiver/tests/commitment_vectors.move` (generated from the JSON)

Do not hand-edit this file or the generated `commitment_vectors.move`. Regenerate
both from the generator, which is the single source of truth:

```bash
cd sdk && npm run gen:vectors
```
