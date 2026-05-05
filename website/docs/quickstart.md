---
sidebar_position: 2
title: Quickstart
---

# Quickstart

Get Bosphor running on Sepolia + Sui Testnet.

## Prerequisites

- **Node.js 22** (pinned via `.nvmrc`)
- **Foundry** for EVM contract compilation and deployment
- **Sui CLI** for Sui contract deployment
- **Sepolia ETH** for EVM gas and LayerZero fees
- **Sui testnet SUI** for Sui gas (`sui client faucet`)

## Setup

```bash
git clone https://github.com/AliErcanOzgokce/bosphor.git
cd bosphor
nvm use
npm install
```

## Environment

```bash
cp .env.example .env
```

Fill in the required variables:

| Variable | Description |
|----------|-------------|
| `EVM_RPC_URL` | Sepolia RPC endpoint |
| `EVM_RELAYER_KEY` | Private key with Sepolia ETH |
| `SUI_DEPLOYER_KEY` | Sui private key (`suiprivkey1...` format) |
| `SUI_RELAYER_KEY` | Sui private key for relayer operations |

## One-command deployment

```bash
npm run new-deployment
```

This runs the full sequence: deploy Sui contracts, deploy EVM contracts, wire peers, and run the E2E test.

## Individual steps

If you prefer to run each step separately:

```bash
npm run deploy:sui      # Deploy Sui package + register OApp + set peer
npm run deploy:evm      # Deploy EVM adapter + set peer
npm run wire            # Update peers only
npm run test:e2e        # Run E2E test with LZ polling
```

## Verify deployment

After deployment, check:

- **LZ Explorer**: `https://testnet.layerzeroscan.com/tx/<evm_tx_hash>` -- message status should be DELIVERED
- **SuiScan**: `https://suiscan.xyz/testnet/object/<SUI_LZ_OAPP_ID>` -- OApp object exists
- **Etherscan**: `https://sepolia.etherscan.io/address/<EVM_ADAPTER_ADDRESS>` -- contract verified
