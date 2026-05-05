# Bosphor

> Cross-chain storage intent routing for [Walrus](https://walrus.xyz).

Bosphor routes storage intents from any EVM chain to Walrus on Sui via
LayerZero v2, returning verifiable proof of execution to the origin chain.

## How It Works

```
EVM ──submitIntent──► LayerZero v2 ──► Sui lz_receive
                                            │
                                       Walrus STORE
                                       (deletable blob)
                                            │
EVM ◄──IntentExecuted──◄── Relayer ◄────────┘
```

1. User calls `submitIntent(payload, deadline)` on EVM
2. LayerZero DVN verifies and delivers the message to Sui
3. Relayer uploads the payload to Walrus as a deletable blob
4. Relayer calls `execute_store` on Sui and `confirmExecution` on EVM

## Status

| Component | Status |
|-----------|--------|
| EVM Adapter (Sepolia) | Deployed |
| Sui LZ OApp (Testnet) | Deployed |
| Relayer | Running (NestJS) |
| LZ Executor | Verified (DELIVERED) |
| Mainnet | Planned |

## Quickstart

```bash
git clone https://github.com/AliErcanOzgokce/bosphor
cd bosphor && nvm use && npm install
cp .env.example .env  # fill in keys
npm run new-deployment
```

See [docs/deployment.md](docs/deployment.md) for detailed setup instructions.

## Architecture

- `contracts/src/BosphorAdapter.sol` — EVM OApp (LayerZero v2)
- `sui/lz-receiver/sources/lz_receiver.move` — Sui LZ receiver
- `sui/sources/walrus_executor.move` — Walrus blob executor
- `relayer/` — NestJS relayer service with health endpoint

See [docs/architecture.md](docs/architecture.md) for the full design.

## Testnet Evidence

| Step | TX |
|------|----|
| EVM Intent | [0x223d...](https://sepolia.etherscan.io/tx/0x223d075c73facfa48bddce0e4316548924b40a0fd362ad3628b0a59ae5c1c40c) |
| LZ DELIVERED | [LZ Explorer](https://testnet.layerzeroscan.com/tx/0x223d075c73facfa48bddce0e4316548924b40a0fd362ad3628b0a59ae5c1c40c) |
| Sui Execution | [3MmJ1nk...](https://suiscan.xyz/testnet/tx/3MmJ1nkJEzzmBV9uFFBKdgqJM9sZi3xajJQrZw91WVNW) |
| Walrus Blob | [rfj52maH...](https://aggregator.walrus-testnet.walrus.space/v1/blobs/rfj52maH_ZyCqaMVIfMOJLUtNnu8ZQ_y-8ZW3pUa63s) |
| EVM Confirm | [0x13243e...](https://sepolia.etherscan.io/tx/0x13243e35227e6f2a421381bd1b48191e8fee67a0169861b688861337d7a774f6) |

## Deployed Contracts

| Contract | Network | Address |
|----------|---------|---------|
| BosphorAdapter | Sepolia | `0xbC7EF2F021F517d871282C2bb512C741ad2958c3` |
| LZ OApp | Sui Testnet | `0xa4420716d875fa323c5d543876d03979607dea3c428818566d25d82fea6f6656` |

## Docker

```bash
docker-compose up -d    # starts relayer + prometheus + grafana
```

## Contributing

See [CONTRIBUTING.md](.github/CONTRIBUTING.md).

## License

[MIT](LICENSE)
