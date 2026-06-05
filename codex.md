# Bosphor

Cross-chain storage intent router: EVM → LayerZero v2 → Sui/Walrus → proof back to EVM.

## Status

Milestone 1 complete. Testnet deployment live.

## Architecture

```
EVM submitIntent → LayerZero → Sui lz_receive → IntentReceived event
→ Relayer → Walrus upload → execute_store → EVM confirmExecution
```

The protocol has two verified message paths:

1. **Forward path:** User submits a storage intent on EVM. The BosphorAdapter sends a cross-chain message via LayerZero v2 to Sui, where `lz_receive` emits an `IntentReceived` event.
2. **Return path:** The relayer watches for `IntentReceived`, uploads data to Walrus, calls `execute_store` on Sui, then sends a proof back to EVM via LayerZero. The EVM contract marks the intent as executed.

## Deployed Contracts (Testnet, v5)

- EVM BosphorAdapter (Sepolia): `0xbC7EF2F021F517d871282C2bb512C741ad2958c3`
- Sui Package: `0xa4420716d875fa323c5d543876d03979607dea3c428818566d25d82fea6f6656`
- Sui OApp Object: `0x9631910c0bc687a74f0b99dd88d2f0033c393aa36735095de8cce67d5eeb27b0`
- LZ Endpoint (Sepolia): `0x6EDCE65403992e310A62460808c4b910D972f10f` (EID 40161)
- Sui Testnet EID: 40378

## Build and Test Commands

```bash
# Solidity build + tests
cd contracts/evm && forge build && forge test -vvv

# Move tests
cd sui/lz-receiver && sui move test --build-env testnet

# Relayer build
cd relayer && npm run build

# End-to-end cross-chain test
npm run test:e2e
```

## npm Scripts

- `npm run deploy:sui` — Sui deploy + register_oapp + set_peer
- `npm run deploy:evm` — EVM deploy + setPeer
- `npm run wire` — peer update only
- `npm run test:e2e` — E2E test with LZ polling
- `npm run new-deployment` — full: deploy-sui + deploy-evm + wire + e2e

## Key Technical Notes

### LayerZero v2
- OApp = OAppSender + OAppReceiver + OAppCore(Ownable)
- LZ v2 uses OpenZeppelin v4.9.6 (not v5)
- EVM setPeer for Sui: must use PACKAGE ID (not OApp Object ID)
- OAppInfoV1 format: `lz_receive_info` must be wrapped in `OAppInfoV1::encode()`
- `waitForTransaction` required between consecutive Sui transactions to avoid object version conflicts
- Sui LZ packages: OApp `0x04c440985f5deab2fb7f821b3288d93225a3e637cf22dda476809836f0533751`, EndpointV2 `0xabf9629418d997fcc742a5ca22820241b72fb53691f010bc964eb49b4bd2263a`

### Sui
- `sui client publish` needs positional arg; `Published.toml` must be removed for fresh deploy
- CallCap stored in LzReceiverConfig (not directly accessible via PTB)
- `register_oapp` entry function wraps `endpoint_v2::register_oapp` with internal CallCap access

### Runtime
- Node 22 required (.nvmrc pinned). tsx + @mysten/sui incompatible with Node 24.
- Relayer stack: ethers v6 + @mysten/sui v1 + tsx

## Conventions

- **Commits:** Conventional Commits format: `type(scope): description`
- **Scopes:** contracts, sui, relayer, scripts, docs, website, ci, config
- **Branch naming:** `type/short-description` (e.g. `feature/batch-intents`, `fix/relayer-reconnect`)
- **Product name:** Always "Bosphor" (PascalCase). Only lowercase in file paths and package names.
- **No em dashes** in any generated text.

## Directory Structure

- `contracts/evm/` — Solidity contracts (Foundry)
- `sui/lz-receiver/` — Move package (LayerZero receiver + Walrus executor)
- `relayer/` — TypeScript relayer service
- `scripts/` — Deployment and wiring scripts
- `website/` — Docusaurus documentation site
