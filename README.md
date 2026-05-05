# Bosphor

Cross-chain intent execution: EVM intent → LayerZero v2 → Sui/Walrus blob storage → proof back to EVM.

## Architecture

```
User (EVM) → BosphorAdapter.sol → LZ v2 → Sui lz_receiver
                                                ↓
                                          IntentReceived event
                                                ↓
                                          Relayer (index.ts)
                                                ↓
                                    walrus_executor.move → Walrus blob store
                                                ↓
                                          StorageExecuted event
                                                ↓
                                    Relayer confirms on EVM
                                                ↓
                                    IntentExecuted event + proof
```

## Structure

```
contracts/     Solidity — BosphorAdapter OApp (Foundry)
sui/           Move — walrus_executor + lz_receiver
relayer/       TypeScript — event listener & executor
scripts/       TypeScript — deployment & testing scripts
```

## Deployment

### Prerequisites

- Node.js 22 (see `.nvmrc`)
- [Sui CLI](https://docs.sui.io/build/install)
- [Foundry](https://book.getfoundry.sh/getting-started/installation)
- Sui testnet account with gas (`sui client faucet`)
- Sepolia ETH for EVM deployment

### Full Deployment (Sui + EVM + Wire + E2E Test)

```bash
npm install
npm run new-deployment
```

This runs sequentially:
1. `deploy:sui` — publish Sui package, register OApp, configure LZ libraries/DVN
2. `deploy:evm` — deploy BosphorAdapter on Sepolia, setPeer for Sui
3. `wire` — connect peers on both chains (Sui set_peer + EVM setPeer)
4. `test:e2e` — send intent, wait for LZ delivery (15 min timeout)

### Individual Commands

```bash
# Deploy Sui LZ OApp
npm run deploy:sui

# Deploy EVM BosphorAdapter
npm run deploy:evm

# Wire peers (after both are deployed)
npm run wire

# E2E test
npm run test:e2e
```

### Environment Variables

Copy `.env.example` to `.env` and fill in:

```bash
cp .env.example .env
```

Key variables:
- `EVM_RELAYER_KEY` — EVM deployer/relayer private key
- `SUI_DEPLOYER_KEY` — Sui deployer private key (AdminCap owner)
- `SUI_RELAYER_KEY` — Sui relayer private key

After deployment, scripts auto-update `.env` with deployed addresses.

### Relayer

```bash
cd relayer
npm install
npm start
```

## Flow

1. User calls `submitIntent(dstEid, payload, deadline, options)` on EVM
2. LZ v2 delivers message to Sui `lz_receiver`
3. Relayer picks up `IntentReceived` event on Sui
4. Relayer uploads payload to Walrus → calls `execute_store` on Sui
5. Relayer calls `confirmExecution(intentId, proof)` on EVM
6. Done — both chains have records of the execution

## Known Limitations

- **Node.js version**: Must use Node 22 (tsx + @mysten/sui incompatible with Node 24).
