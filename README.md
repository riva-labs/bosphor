# Bosphor — Storage Intent Router for Walrus

Cross-chain storage made simple. Any EVM chain can store data on
Walrus and receive verifiable proof back — without touching Sui.

## How It Works

```
EVM → LayerZero → Sui → Walrus → LayerZero → EVM
```

1. Developer submits storage intent on any EVM chain
2. LayerZero routes the message to Sui
3. Relayer uploads data to Walrus
4. Proof returns to origin chain via LayerZero

## Testnet Evidence

| Step | Link |
|------|------|
| EVM Intent (Sepolia) | [0x223d...](https://sepolia.etherscan.io/tx/0x223d075c73facfa48bddce0e4316548924b40a0fd362ad3628b0a59ae5c1c40c) |
| LayerZero DELIVERED | [LZ Explorer](https://testnet.layerzeroscan.com/tx/0x223d075c73facfa48bddce0e4316548924b40a0fd362ad3628b0a59ae5c1c40c) |
| Sui Execution | [3MmJ1nk...](https://suiscan.xyz/testnet/tx/3MmJ1nkJEzzmBV9uFFBKdgqJM9sZi3xajJQrZw91WVNW) |
| Walrus Blob | [rfj52maH...](https://aggregator.walrus-testnet.walrus.space/v1/blobs/rfj52maH_ZyCqaMVIfMOJLUtNnu8ZQ_y-8ZW3pUa63s) |
| EVM Confirmation | [0x13243e...](https://sepolia.etherscan.io/tx/0x13243e35227e6f2a421381bd1b48191e8fee67a0169861b688861337d7a774f6) |

## Quickstart

### Prerequisites

- Node.js 22 (see `.nvmrc`)
- [Foundry](https://book.getfoundry.sh/getting-started/installation)
- [Sui CLI](https://docs.sui.io/build/install)
- Sepolia ETH + Sui testnet SUI for deployment

### Setup

```bash
git clone https://github.com/AliErcanOzgokce/bosphor
cd bosphor
cp .env.example .env
# fill in .env with your keys
nvm use 22
npm install
```

### Deploy & Test

```bash
# Full deployment + E2E test
npm run new-deployment

# Or step by step
npm run deploy:sui    # Deploy Sui OApp
npm run deploy:evm    # Deploy EVM Adapter
npm run wire          # Connect peers
npm run test:e2e      # Run E2E test
```

### Docker (Relayer)

```bash
docker-compose up -d
```

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

### Contracts

- `contracts/src/BosphorAdapter.sol` — EVM OApp (LayerZero v2)
- `sui/lz-receiver/sources/lz_receiver.move` — Sui LZ OApp receiver
- `sui/sources/walrus_executor.move` — Walrus blob storage executor

### Relayer

- `relayer/index.ts` — Event-driven Node.js relayer

### Scripts

- `scripts/deploy-sui.ts` — Automated Sui deployment
- `scripts/deploy-evm.ts` — Automated EVM deployment
- `scripts/wire.ts` — Peer connection
- `scripts/e2e-test.ts` — E2E verification

## Deployed Contracts (Testnet)

| Contract | Address |
|----------|---------|
| EVM BosphorAdapter (Sepolia) | `0xbC7EF2F021F517d871282C2bb512C741ad2958c3` |
| Sui LZ OApp | `0xa4420716d875fa323c5d543876d03979607dea3c428818566d25d82fea6f6656` |
| Sui OApp Object | `0x9631910c0bc687a74f0b99dd88d2f0033c393aa36735095de8cce67d5eeb27b0` |

## Known Limitations

- **Node.js version**: Must use Node 22 (tsx + @mysten/sui incompatible with Node 24)
