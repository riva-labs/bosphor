---
sidebar_position: 4
title: Deployment Guide
---

# Deployment Guide

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

1. Builds a test payload
2. Quotes LZ fee via `adapter.quote()`
3. Calls `submitIntent` with quoted fee
4. Polls LZ Scan API every 15 seconds for up to 15 minutes
5. Reports DELIVERED / FAILED / TIMEOUT with all TX links

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
