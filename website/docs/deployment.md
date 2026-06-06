---
sidebar_position: 4
title: Deployment Guide
---

# Deployment Guide

import AgentPrompt from '@site/src/components/AgentPrompt';

<AgentPrompt prompt="Deploy the Bosphor contracts to Sepolia and Sui testnet. My .env file is already configured with RPC URLs and private keys. Run `npm run deploy:sui` first, then `npm run deploy:evm`, then `npm run wire` to set peers on both chains. After deployment, verify the contracts on Etherscan and SuiScan, and run `npm run test:e2e` to confirm the full round-trip works." />

## Prerequisites

- **Node.js 22** -- pinned via `.nvmrc` (`nvm use`)
- **Foundry** -- `curl -L https://foundry.paradigm.xyz | bash && foundryup`
- **Sui CLI** -- https://docs.sui.io/build/install
- **Sepolia ETH** -- for EVM contract deployment and LZ fees
- **Sui testnet SUI** -- for Sui contract deployment (`sui client faucet` or https://faucet.sui.io)

## Environment Setup

```bash
cp .env.example .env
```

### Required Variables

| Variable | Description |
|----------|-------------|
| `EVM_RPC_URL` | Sepolia RPC endpoint (e.g. `https://ethereum-sepolia-rpc.publicnode.com`) |
| `EVM_RELAYER_KEY` | Private key for EVM deployer/relayer (must have Sepolia ETH) |
| `SUI_DEPLOYER_KEY` | Sui private key in `suiprivkey1...` format (AdminCap owner) |
| `SUI_RELAYER_KEY` | Sui private key for relayer operations |

### Auto-populated Variables

These are written by deployment scripts -- leave empty:

| Variable | Populated by |
|----------|-------------|
| `EVM_ADAPTER_ADDRESS` | `deploy-evm.ts` |
| `SUI_LZ_PACKAGE_ID` | `deploy-sui.ts` |
| `SUI_LZ_CONFIG_ID` | `deploy-sui.ts` |
| `SUI_LZ_OAPP_ID` | `deploy-sui.ts` |
| `SUI_LZ_ADMIN_CAP_ID` | `deploy-sui.ts` |
| `SUI_LZ_MESSAGING_CHANNEL` | `deploy-sui.ts` |

## Full Deployment

```bash
npm install
npm run new-deployment
```

This runs sequentially:

### 1. `npm run deploy:sui`

1. Removes `Published.toml` for fresh publish
2. Runs `sui client publish` with 500M gas budget
3. Waits for transaction finality
4. Calls `register_oapp` with `OAppInfoV1`-formatted metadata
5. Sets send/receive libraries to ULN302
6. Configures DVN (LayerZero Labs) and executor
7. If `EVM_ADAPTER_ADDRESS` is set, calls `set_peer`
8. Updates `.env` with all new object IDs

### 2. `npm run deploy:evm`

1. Runs `forge build`
2. Deploys `BosphorAdapter` with LZ endpoint and deployer as delegate + relayer
3. If `SUI_LZ_PACKAGE_ID` is set, calls `setPeer(40378, suiPackageId)`
4. Updates `.env` with `EVM_ADAPTER_ADDRESS`

### 3. `npm run wire`

1. EVM `setPeer(40378, suiPackageId)` -- uses PACKAGE ID, not OApp object
2. Sui `set_peer(40161, evmAdapterAddress)`

### 4. `npm run test:e2e`

Two-step verification of the full round-trip:

**Phase 1 (Forward):**
1. Builds a test payload and quotes LZ fee
2. Calls `submitIntent` on EVM
3. Polls LZ Scan API for forward delivery (EVM -> Sui)

**Phase 2 (Return):**
4. Waits for the relayer to process the intent (Walrus upload + execute_store)
5. Polls EVM for `IntentExecuted` event (proof delivered back via LZ)
6. Decodes proof data (blob ID, end epoch) from the event

The test outputs a 6-checkpoint summary with TX hashes and explorer links for both chains. Set `SUI_PACKAGE_ID` and `SUI_LZ_PACKAGE_ID` in `.env` for full Sui event details (Walrus blob, proof TX).

## Docker (Relayer)

```bash
docker-compose up -d
```

The relayer container:
- Polls EVM `IntentSubmitted` events
- Polls Sui `IntentReceived` events (LZ path)
- Uploads payloads to Walrus (deletable blobs)
- Calls `execute_store` on Sui
- Sends proof back to EVM via LayerZero (`lz_send_proof` on Sui)

## Verification

After deployment, verify:

1. **LZ Explorer**: `https://testnet.layerzeroscan.com/tx/<evm_tx_hash>` -- status should be DELIVERED
2. **SuiScan**: `https://suiscan.xyz/testnet/object/<SUI_LZ_OAPP_ID>` -- verify OApp exists
3. **Etherscan**: `https://sepolia.etherscan.io/address/<EVM_ADAPTER_ADDRESS>` -- verify contract
4. **Walrus**: `https://aggregator.walrus-testnet.walrus.space/v1/blobs/<blob_id>` -- verify blob retrieval
5. **Move Registry**: search `@bosphor/core` at https://www.moveregistry.com or run `mvr resolve @bosphor/core --network testnet`

### Move Registry

| Item | Value |
|------|-------|
| MVR Name | `@bosphor/core` |
| SuiNS Name | `bosphor.sui` |
| Testnet PackageInfo | `0x1927186c77ee261f67f6646efb1403b08643c912cbd1fdcfea6b60d4e1627360` |
| Mainnet AppCap | `0x12f12b1135dc87b262d937c4c878ea5b54df0c036e2a00675bc448427f9f1aff` |
| MVR Registry | `0x0e5d473a055b6b7d014af557a13ad9075157fdc19b6d51562a18511afd397727` |
