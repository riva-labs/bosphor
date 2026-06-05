---
sidebar_position: 2
title: Quickstart
---

# Quickstart

Get Bosphor running on Sepolia + Sui Testnet in about 15 minutes.

import AiPrompt from '@site/src/components/AiPrompt';

<AiPrompt>
{`Clone the Bosphor repo with submodules, install dependencies, and set up the environment for Sepolia + Sui testnet. I need Node.js 22, Foundry, and the Sui CLI. Then copy .env.example to .env, help me fill in the required variables (EVM_RPC_URL, EVM_RELAYER_KEY, SUI_DEPLOYER_KEY, SUI_RELAYER_KEY), and run \`npm run new-deployment\` to deploy everything and verify with the E2E test.`}
</AiPrompt>

## Prerequisites

### Node.js 22

Bosphor requires Node.js 22 (pinned via `.nvmrc`).

```bash
nvm install 22
nvm use 22
```

### Foundry

Install Foundry for EVM contract compilation and deployment:

```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

Verify with `forge --version`.

### Sui CLI

Install the Sui CLI for Sui contract deployment. See the [Sui install guide](https://docs.sui.io/guides/developer/getting-started/sui-install) for full instructions.

After installation, configure for testnet:

```bash
sui client new-env --alias testnet --rpc https://fullnode.testnet.sui.io:443
sui client switch --env testnet
```

### Testnet tokens

- **Sepolia ETH** for EVM gas and LayerZero fees. Use the [Alchemy Sepolia Faucet](https://www.alchemy.com/faucets/ethereum-sepolia) or [Google Cloud Sepolia Faucet](https://cloud.google.com/application/web3/faucet/ethereum/sepolia).
- **Sui testnet SUI** for Sui gas:

```bash
sui client faucet
```

Or use the [Sui Testnet Faucet](https://faucet.testnet.sui.io/).

## Setup

```bash
git clone --recurse-submodules https://github.com/AliErcanOzgokce/bosphor.git
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

## What success looks like

After a successful deployment, you should see:

1. **Sui deploy** prints the package ID and OApp object ID.
2. **EVM deploy** prints the BosphorAdapter contract address.
3. **Wire** confirms peers are set on both chains.
4. **E2E test** submits an intent on Sepolia, waits for LayerZero delivery, and confirms the `IntentReceived` event on Sui. Output ends with a success message and transaction hashes for both chains.

## Verify deployment

After deployment, check:

- **LZ Explorer**: `https://testnet.layerzeroscan.com/tx/<evm_tx_hash>` for message status DELIVERED
- **SuiScan**: `https://suiscan.xyz/testnet/object/<SUI_LZ_OAPP_ID>` for OApp object
- **Etherscan**: `https://sepolia.etherscan.io/address/<EVM_ADAPTER_ADDRESS>` for contract verification

## Troubleshooting

If you run into issues during setup or deployment, see the [Troubleshooting](troubleshooting.md) page for solutions to common problems including setup errors, deployment failures, relayer issues, and cross-chain debugging.
