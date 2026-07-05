# Milestone 1 Status Report — Cross-Chain Execution Core

**Project:** Bosphor — Storage Intent Router
**Grantee:** Riva Labs
**Foundation:** Walrus Foundation
**Milestone:** 1 of 5 — Cross-Chain Execution Core (USD $20,000 in Tokens)
**Release:** [`v0.1.0`](https://github.com/riva-labs/bosphor/releases/tag/v0.1.0) — tagged 2026-06-25
**Report date:** 2026-07-01

> **Scope.** This report covers Milestone 1 as delivered in release `v0.1.0` and the code up to that release. Work begun afterward on Milestone 2 (system stabilization and monitoring) is out of scope here and is not described as part of Milestone 1.

---

## 1. Executive summary

Milestone 1 delivers the complete Cross-Chain Execution Core: an EVM developer submits a storage intent on their origin chain, the intent is routed over LayerZero v2 to Sui, the payload is stored on Walrus, and a cryptographically verifiable proof is returned over a separate LayerZero message and verified back on the origin chain. No Sui infrastructure and no Move code are required of the originating developer.

The full round trip is live and independently verifiable on Sepolia and Sui Testnet, documented on public explorers in the `v0.1.0` release and reproducible on demand via `npm run test:e2e`. All six functional deliverables (a–f) are complete, the package is registered in the Move Registry as [`@bosphor/core`](https://www.moveregistry.com/package/@bosphor/core), and all data is stored on Walrus as deletable blobs per the grant obligation.

**Grantee recommendation: proceed to Milestone 2.** Rationale in Section 4.

---

## 2. Integration architecture and design decisions

### 2.1 End-to-end message flow

```
User → submitIntent (EVM BosphorAdapter)
     → _lzSend  ──LayerZero v2 (DVN verified)──▶  lz_receive (Sui lz_receiver)  → IntentReceived
     → Relayer observes IntentReceived
     → Walrus upload (deletable blob)  → execute_store (Sui walrus_executor)
     → lz_send_proof  ──LayerZero v2 (type-1 msg)──▶  _lzReceive (EVM)  → intent marked executed
```

The system is two independent LayerZero messages, not one round-trip call: a **request** message (EVM → Sui) and a separate **response** message (Sui → EVM). The origin chain confirms storage by verifying the returned LayerZero message through the messaging layer, not by trusting a relayer-observed event.

### 2.2 Components

| Component | Role | Location |
|-----------|------|----------|
| `BosphorAdapter.sol` | EVM entry point: `submitIntent`, fee `quote`, proof `_lzReceive`, emergency `confirmExecution` | `contracts/evm/` |
| `lz_receiver.move` | Receives the LZ request on Sui, validates peer + endpoint, records intent, emits `IntentReceived` | `sui/lz-receiver/` |
| `walrus_executor.move` | Accepts a certified Walrus `Blob`, verifies certification and deadline, emits `StorageExecuted`, transfers blob + receipt to the sender | `sui/lz-receiver/` |
| `codec.move` | Encodes/decodes the 97-byte type-1 proof message | `sui/lz-receiver/` |
| `ptb_builder.move` | Produces `OAppInfoV1`-encoded PTB metadata for the LZ executor | `sui/lz-receiver/` |
| Relayer | Dockerized NestJS service: observes intents, uploads to Walrus, calls `execute_store` and `lz_send_proof` | `relayer/` |

### 2.3 Key design decisions

1. **Two-step LayerZero verification over relayer attestation.** The execution result returns over a dedicated LayerZero response message and is verified on the origin chain through DVN-backed messaging. The relayer triggers the flow but cannot forge a proof. This is the core trust property of the design and directly satisfies deliverable (c).

2. **`OAppInfoV1` executor registration.** On Sui, the LZ executor expects the OApp to expose PTB construction metadata in `OAppInfoV1` format (`[version][BCS(oapp_object, next_nonce_info, lz_receive_info, extra_info)]`). An early version returned raw `MoveCall` bytes and the executor could not deserialize it; wrapping `lz_receive_info` in `OAppInfoV1::encode()` resolved delivery. Documented as a first-class integration note.

3. **Compact type-1 wire format.** The proof message is a fixed 97 bytes: `0x01 ++ intentId(32) ++ blobId(32) ++ endEpoch(32, big-endian u256)`. A tagged, fixed-length format keeps decoding cheap and unambiguous on both chains.

4. **Deterministic intent IDs.** `intentId = keccak256(sender, dstEid, payload, nonce, deadline)`. The same identity is computable on both chains, which makes end-to-end correlation and deduplication trivial.

5. **Deletable blobs by policy.** The executor stores every blob as deletable, enforced in code, satisfying the grant obligation that no path can produce a non-deletable blob.

6. **Bidirectional deadline enforcement.** Deadlines are checked on EVM (`submitIntent` rejects expired) and on Sui (`execute_store` checks the on-chain clock), so a stale intent cannot be executed late.

7. **Single trusted relayer for Milestone 1.** One authorized relayer runs both the Walrus execution and the LZ return path. This is a deliberate scope decision for the execution core; a competing/permissionless relayer model is on the roadmap. The relayer can censor (decline to fulfill) but cannot forge proofs.

8. **LayerZero v2 on OpenZeppelin v4.9.6.** LZ v2's `OAppCore` uses msg.sender-based Ownable from OZ v4.9.6, not v5. Pinning the dependency avoids an Ownable mismatch.

---

## 3. Results of the end-to-end demonstrations

Deliverable (e) requires at least two documented end-to-end demonstrations with on-chain artifacts sufficient for independent verification.

### 3.1 Demonstration 1 — archived live run (in the `v0.1.0` release)

The release documents a complete round trip with every hop on a public explorer:

| # | Step | Artifact |
|---|------|----------|
| 1 | EVM intent submitted (Sepolia) | Etherscan tx `0xde576c41…765aa2` |
| 2 | LayerZero request DELIVERED (Sepolia → Sui) | LayerZero Scan |
| 3 | Sui executes the Walrus STORE | SuiScan tx `5dcGjoC9…BrZMv` |
| 4 | Blob stored on Walrus | Walruscan blob `1sfeIRiJ…LQvU` |
| 5 | Proof returned over a separate LZ message and verified on Sepolia | LayerZero Scan + Etherscan tx `0x94196661…9c1309` |

Full links are in the [release notes](https://github.com/riva-labs/bosphor/releases/tag/v0.1.0).

### 3.2 Demonstration 2 — reproducible on-demand run (`npm run test:e2e`)

`npm run test:e2e` runs the full flow with two-phase LayerZero verification and prints fresh explorer links each run:

- **Forward phase:** quote the LZ fee, call `submitIntent`, poll LayerZero Scan until the message shows DELIVERED on Sui.
- **Return phase:** wait for the relayer to upload to Walrus, call `execute_store` and `lz_send_proof`, then poll EVM for the `IntentExecuted` event and decode the returned blob ID and end epoch.

Each execution is an independently documented demonstration: any reviewer with the testnet environment can run it and verify the emitted transactions on Etherscan, LayerZero Scan, SuiScan, and Walruscan. This makes the demonstration repeatable rather than a single snapshot.

### 3.3 Automated test coverage (at `v0.1.0`)

| Layer | Framework | Result |
|-------|-----------|--------|
| Solidity (`BosphorAdapter`) | Forge | **25 passed / 0 failed** |
| Move (`lz_receiver`, `codec`) | `sui move test` | **12 passed / 0 failed** |
| Relayer (7 suites) | Jest | **44 passed / 0 failed** |
| Cross-chain | E2E harness | Full round trip verified on live testnet |

**81 unit tests pass** across the three layers. CI runs the Solidity, Move, and relayer suites in parallel on every push and PR via GitHub Actions (deliverable d: reproducible CI/CD). The E2E test is excluded from CI because it requires live testnet deployments and a running relayer.

---

## 4. Known gaps, tooling limitations, and open items

These are the constraints of the initial release as documented in [Known Limitations](https://docs.bosphor.xyz/known-limitations) (deliverable f). They are scope decisions and testnet realities, not defects.

### 4.1 Architectural (by design for Milestone 1)

- **Single relayer trust model.** One trusted relayer; if it is offline, intents are not fulfilled until it recovers. It can censor but cannot forge proofs (DVN-verified). A competing/permissionless relayer model is roadmapped.
- **No origin-chain payment / fee recovery.** The relayer pays all LZ fees and Sui gas; there is no on-chain mechanism to recover costs from the intent sender. Sustainability currently depends on off-chain funding. Origin-chain payment flow is a later milestone.
- **Single DVN (LayerZero Labs).** One DVN configuration on testnet. Multi-DVN is a hardening item.
- **Relayer triggers proof verification, and no on-chain intent cancellation.** A submitted intent is either fulfilled before its deadline or expires silently; there is no cancel path.

### 4.2 Chain and protocol scope

- EVM origin: Sepolia testnet only (mainnet support exists in code but is not activated).
- Storage: Walrus on Sui testnet only; blobs are deletable, fixed `WALRUS_STORE_EPOCHS` (default 5), no per-intent duration.
- Multi-EVM (Arbitrum, Base, Optimism) is planned; Solana origin is a later milestone.

### 4.3 Tooling and operational constraints

- **LZ fee estimation under gas volatility.** LZ messaging fees are quoted with a 10% buffer. In periods of sharp gas volatility the buffer can be insufficient and the send fails; the relayer retries with an updated fee quote.
- **Off-chain funding of the relayer.** The relayer pays all LZ fees and Sui gas from its own wallets, funded off-chain on testnet. There is no automated funding or fee recovery in the Milestone 1 release.
- **Object version conflicts on Sui.** Consecutive transactions touching the same shared object can fail on version conflict under high throughput; the relayer serializes with `waitForTransaction`, which caps concurrency.
- **Deadline race window.** An intent submitted near its deadline can be accepted on EVM but expire before the relayer executes on Sui; the relayer skips expired intents rather than waste gas.

### 4.4 Open items carried into Milestone 2

- Comprehensive testnet validation with controlled failure injection and recovery testing.
- Real-time monitoring (relay latency, success/failure rates, storage operations, LZ delivery status) and runtime alerting.
- Operational hardening of relayer/wallet funding and health so continuous operation does not require manual intervention.

These are precisely the Milestone 2 deliverables and are the natural next step, not gaps in the Milestone 1 execution core.

---

## 5. Grantee's written recommendation

**We recommend proceeding to Milestone 2 (Proof Validation & System Stabilization).**

The Milestone 1 execution core is complete, live on public testnets, independently verifiable through both an archived on-chain run and a reproducible end-to-end harness, and covered by 81 passing unit tests plus reproducible CI. The core trust property, origin-chain verification of storage through a dedicated LayerZero response message rather than relayer attestation, is implemented and demonstrated.

Milestone 2 is the natural continuation:

- **End-to-end testnet validation and failure injection (M2 deliverable a)** builds directly on the existing E2E harness and the 81-test unit base.
- **Monitoring dashboard (M2 deliverable b)** introduces real-time visibility (relay latency, success/failure rates, Walrus operations, LZ delivery) and alerting on top of the deployed relayer.

No architectural rework is required to begin Milestone 2. The open items in Section 4.4 are the Milestone 2 scope itself.

---

*Prepared by Riva Labs for the Walrus Foundation. All contract addresses, transactions, and blobs referenced are verifiable on public explorers as linked in the `v0.1.0` release notes and at [docs.bosphor.xyz](https://docs.bosphor.xyz).*
