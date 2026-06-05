---
title: Integration Checklist
---

# Integration Checklist

Step-by-step checklist for integrating with Bosphor. Complete each item before moving to the next.

import AiPrompt from '@site/src/components/AiPrompt';

<AiPrompt>
{`Walk me through the Bosphor integration checklist step by step. I need to: (1) understand the architecture and security model, (2) deploy contracts to Sepolia and Sui testnet, (3) verify deployment on Etherscan and SuiScan, (4) run the E2E test, (5) integrate fee estimation and intent submission into my dApp using ethers.js or viem, (6) verify relayer health, and (7) review trust assumptions for production readiness. Guide me through each step and flag anything that needs my input.`}
</AiPrompt>

## Prerequisites

- [ ] Node.js 22 installed (see [Quickstart](quickstart.md))
- [ ] Foundry installed (`forge --version` works)
- [ ] Sui CLI installed (`sui --version` works)
- [ ] Sepolia ETH in your wallet for gas and LayerZero fees
- [ ] Sui testnet SUI in your wallet for gas

## 1. Understand the protocol

- [ ] Read the [Architecture](architecture.md) page to understand the two-step message flow
- [ ] Read the [Security Model](security-model.md) to understand trust assumptions
- [ ] Review [Known Limitations](known-limitations.md) for constraints that may affect your use case

## 2. Deploy contracts

- [ ] Clone the repository with `--recurse-submodules`
- [ ] Copy `.env.example` to `.env` and fill in required variables
- [ ] Run `npm run new-deployment` for a full deploy, or run individual steps:
  - [ ] `npm run deploy:sui` deploys the Sui package and registers the OApp
  - [ ] `npm run deploy:evm` deploys the EVM adapter
  - [ ] `npm run wire` sets peers on both chains

## 3. Verify deployment

- [ ] EVM adapter address is printed in deploy output
- [ ] Sui package ID and OApp object ID are printed in deploy output
- [ ] Peers are set correctly:
  - EVM: `setPeer(40378, suiPackageId)` (uses **package ID**, not OApp object ID)
  - Sui: `set_peer(40161, evmAdapterAddress)`
- [ ] Check [Etherscan](https://sepolia.etherscan.io) for the EVM contract
- [ ] Check [SuiScan](https://suiscan.xyz/testnet) for the Sui package

## 4. Test the integration

- [ ] Run `npm run test:e2e` to verify the full round-trip
- [ ] E2E test submits an intent on Sepolia and waits for:
  1. LayerZero delivery to Sui (`IntentReceived` event)
  2. Relayer processing (Walrus upload, `execute_store`, `lz_send_proof`)
  3. Proof delivery back to EVM (`IntentExecuted` event)

## 5. Fee estimation

- [ ] Call `quote(dstEid, payload, deadline, options)` before `submitIntent` to get the LZ fee
- [ ] Pass the returned `nativeFee` as `msg.value` to `submitIntent`
- [ ] Use the default LZ options (`0x00030100110100000000000000000000000000030d40`) unless your use case requires custom gas limits
- [ ] Understand that the relayer adds a 10% fee buffer on the return path

## 6. Submit intents from your dApp

- [ ] Import `IBosphorAdapter` interface for type-safe interaction
- [ ] Set deadlines with enough buffer for cross-chain delivery (at least 15 minutes recommended)
- [ ] Handle the `IntentSubmitted` event to get the `intentId`
- [ ] Listen for `IntentExecuted` event to confirm fulfillment and decode the proof (blobId, endEpoch)
- [ ] See [dApp Tutorial](dapp-tutorial.md) for complete ethers.js and viem examples

## 7. Relayer health

- [ ] Verify the relayer is running: `GET /health` should return `{"status": "ok"}`
- [ ] Monitor relayer wallet balances (both Sepolia ETH and Sui testnet SUI)
- [ ] Review [Relayer](relayer.md) for configuration and error handling details

## 8. Pre-production review

- [ ] Confirm all trust assumptions are documented and acceptable for your use case
- [ ] Understand the emergency `confirmExecution` fallback and who holds the owner key
- [ ] Review gas costs and fee sustainability
- [ ] Plan for relayer monitoring and alerting
- [ ] Note that mainnet deployment is not yet supported (Sui testnet only)

## Related

- [Contract Interface](contract-interface.md) for function signatures and wire formats
- [dApp Tutorial](dapp-tutorial.md) for frontend integration examples
- [Troubleshooting](troubleshooting.md) for common issues
