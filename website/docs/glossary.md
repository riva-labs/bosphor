---
title: Glossary
---

# Glossary

Key terms used throughout the Bosphor documentation.

## Blob

A unit of data stored on [Walrus](https://www.walrus.xyz/). Bosphor stores intent payloads as deletable blobs. Each blob has a unique blob ID and an expiry epoch. See [Architecture](architecture.md) for how blobs fit into the message flow.

## Cross-chain message

A message sent between chains via [LayerZero v2](#layerzero-v2). Bosphor uses two cross-chain messages per intent: one to deliver the intent (EVM to Sui) and one to return the execution proof (Sui to EVM). Both are verified by DVNs.

## DVN (Decentralized Verifier Network)

A set of independent verifiers in LayerZero v2 that validate cross-chain messages before delivery. Bosphor currently uses the LayerZero Labs DVN with a confirmation depth of 2 blocks. DVN verification is what makes the message flow trustless. See [LZ Verification Flow](lz-verification-flow.md).

## EID (Endpoint ID)

A numeric identifier for a chain in LayerZero v2. Sui testnet is `40378`, Sepolia is `40161`. EIDs are used in peer configuration and message routing. Unit tests use a mock EID `30378`. See [Deployment](deployment.md) for peer setup.

## Epoch

A time period in Walrus that determines how long a blob is stored. Bosphor stores blobs for `WALRUS_STORE_EPOCHS` epochs (default: 5). The `endEpoch` value in execution proofs indicates when the blob expires.

## Intent

A storage request submitted on an EVM chain. An intent contains a payload (the data to store), a deadline (expiry timestamp), and a destination chain EID. Each intent gets a deterministic `intentId` computed from the sender, chain, payload, nonce, and deadline. See [Contract Interface](contract-interface.md).

## LayerZero v2

The cross-chain messaging protocol Bosphor uses for both directions of the message flow. LayerZero v2 provides DVN-verified message delivery between EVM and Sui. See [LZ Verification Flow](lz-verification-flow.md).

## OApp (Omnichain Application)

A LayerZero v2 application contract that can send and receive cross-chain messages. Bosphor's `BosphorAdapter` on EVM and `lz_receiver` on Sui are both OApps. OApps must register peers to accept messages from each other.

## Peer

A cross-chain OApp counterpart. Each OApp must configure the address of its peer on the remote chain using `setPeer` (EVM) or `set_peer` (Sui). On EVM, the Sui peer is set to the Sui package ID (not the OApp object ID). See [Deployment](deployment.md).

## Proof

An execution receipt sent from Sui back to EVM after a storage intent is fulfilled. The proof contains the Walrus `blobId` and `endEpoch`, encoded as a type 1 message: `0x01 ++ abi.encode(intentId, blobId, endEpoch)`. Proofs are DVN-verified by LayerZero.

## Relayer

The off-chain service that processes intents. The relayer polls for `IntentReceived` events on Sui, uploads payloads to Walrus, calls `execute_store`, and sends the proof back to EVM via `lz_send_proof`. The relayer triggers execution but cannot forge proofs. See [Relayer](relayer.md).
