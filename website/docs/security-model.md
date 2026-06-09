---
title: Security Model
---

# Security Model

Bosphor's security relies on LayerZero v2 DVN verification for both legs of the cross-chain message flow, with the relayer acting as an untrusted executor that cannot forge proofs.

## Trust boundaries

### Trustless (DVN-verified)

These operations are verified by LayerZero's Decentralized Verifier Network and do not require trust in any single party:

- **Intent delivery (EVM to Sui)**: The `submitIntent` message is sent through LayerZero and verified by DVNs before delivery to Sui. No party can forge or modify the message in transit.
- **Proof verification (Sui to EVM)**: The execution proof (`blobId`, `endEpoch`) is sent through LayerZero and verified by DVNs before delivery to EVM. The relayer initiates this send, but the proof content is verified on-chain.
- **Intent registration**: Nonce enforcement, deadline checks, and intent ID computation are all on-chain.
- **Execution recording**: `execute_store` on Sui verifies blob certification, checks deadlines against the Sui clock, and prevents double-execution.

### Trusted (relayer-dependent)

These operations depend on the relayer behaving correctly:

- **Triggering execution**: The relayer decides when to upload to Walrus and call `execute_store`. If the relayer is offline or unresponsive, intents will not be fulfilled until it recovers.
- **Timing**: The relayer controls how quickly intents are processed. A slow relayer may cause intents to expire before fulfillment.

## What the relayer can do

| Action | Possible? | Impact |
|--------|-----------|--------|
| Delay fulfillment | Yes | Intents may expire if not processed before deadline |
| Censor specific intents | Yes | The relayer can skip intents selectively |
| Go offline | Yes | All intent processing stops until recovery |
| Choose processing order | Yes | The relayer decides which intents to process first |

## What the relayer cannot do

| Action | Why not |
|--------|---------|
| Forge execution proofs | Proofs are DVN-verified by LayerZero. The relayer cannot create a valid proof without actually storing the data on Walrus. |
| Steal user funds | Bosphor does not custody user funds. The relayer pays gas and LZ fees from its own wallet. |
| Modify intent payloads | Intent payloads are encoded on-chain at submission time and verified on Sui via ABI decoding. |
| Double-execute an intent | Both `execute_store` (Sui) and `_lzReceive` (EVM) reject duplicate executions. |
| Bypass deadline checks | Deadlines are enforced on-chain by both the EVM adapter and the Sui executor. |

## Emergency fallback

The contract owner can call `confirmExecution(intentId, proof)` directly on the EVM adapter to manually confirm an intent's execution. This is an owner-only emergency function intended for disaster recovery (e.g., if LayerZero message delivery fails permanently).

This function bypasses the DVN-verified proof path. It should only be used when the normal `_lzReceive` path is unavailable and the owner has independently verified that the intent was fulfilled.

## DVN configuration

Bosphor currently uses a single DVN: **LayerZero Labs DVN**.

- Confirmation depth: 2 blocks (EVM to Sui)
- Verification: both message directions (forward and return) pass through DVN verification
- The DVN configuration is set during OApp registration and can be updated through LayerZero's endpoint

A single-DVN setup means that DVN compromise would compromise message verification. Multi-DVN support (requiring multiple independent verifiers to agree) is planned for the hardening phase.

## Attack surface summary

| Vector | Mitigation |
|--------|-----------|
| Relayer compromise | Relayer cannot forge proofs (DVN-verified). Can only delay or censor. Owner fallback available. |
| DVN compromise | Single DVN risk. Multi-DVN planned. |
| Walrus publisher outage | SDK handles retries internally. Intents expire gracefully if storage nodes remain unavailable. |
| LZ endpoint compromise | Protocol-level risk shared with all LayerZero applications. |
| Contract owner key compromise | Owner can call `confirmExecution` and `setRelayer`. Standard key management practices apply. |

## Related

- [Architecture](architecture.md) for the full message flow
- [Known Limitations](known-limitations.md) for operational constraints
- [LZ Verification Flow](lz-verification-flow.md) for DVN verification details
