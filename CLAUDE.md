# Bosphor — Project Context

Cross-chain storage intent router: EVM → LayerZero v2 → Sui/Walrus → proof back to EVM.

## Status: Milestone 1 COMPLETE

## Deployed Contracts (Testnet — v5)
- EVM BosphorAdapter (Sepolia): 0xbC7EF2F021F517d871282C2bb512C741ad2958c3
- Sui Package: 0xa4420716d875fa323c5d543876d03979607dea3c428818566d25d82fea6f6656
- Sui OApp Object: 0x9631910c0bc687a74f0b99dd88d2f0033c393aa36735095de8cce67d5eeb27b0
- LZ Endpoint (Sepolia): 0x6EDCE65403992e310A62460808c4b910D972f10f (EID 40161)
- Sui Testnet EID: 40378

## Key Fix (v5)
ptb_builder::lz_receive_info was returning raw MoveCall bytes.
LZ executor expects OAppInfoV1 format: [version][BCS(address, vec<u8>, vec<u8>, vec<u8>)].
Fix: wrapped with oapp_info_v1::create().encode().

## Architecture
EVM submitIntent → LZ → Sui lz_receive → IntentReceived event
→ Relayer → Walrus upload → execute_store → EVM confirmExecution

## npm Scripts
- npm run deploy:sui      — Sui deploy + register_oapp + set_peer
- npm run deploy:evm      — EVM deploy + setPeer
- npm run wire            — peer update only
- npm run test:e2e        — E2E test with LZ polling
- npm run new-deployment  — full: deploy-sui + deploy-evm + wire + e2e

## Key Technical Notes

### LayerZero v2
- OApp = OAppSender + OAppReceiver + OAppCore(Ownable)
- LZ-v2 uses OpenZeppelin v4.9.6 (NOT v5 — OAppCore msg.sender-based Ownable)
- Sui testnet EID: 40378
- LZ TestHelper too complex → minimal EndpointV2Mock kullanılıyor
- Sui LZ packages: OApp `0x04c440985f5deab2fb7f821b3288d93225a3e637cf22dda476809836f0533751`, EndpointV2 `0xabf9629418d997fcc742a5ca22820241b72fb53691f010bc964eb49b4bd2263a`
- EVM setPeer for Sui: Must use PACKAGE ID (not OApp Object ID)
- OAppInfoV1 format: lz_receive_info MUST be wrapped in OAppInfoV1::encode()
- sui client publish: Needs positional arg, Published.toml must be removed for fresh deploy
- waitForTransaction: Required between consecutive Sui TX's to avoid object version conflicts

### Sui Package Upgrade
- CallCap stored in LzReceiverConfig (not directly accessible via PTB)
- register_oapp entry function wraps endpoint_v2::register_oapp with internal CallCap access
- Upgrade via sui client upgrade --upgrade-capability <cap_id>

### Runtime
- Node 22 required (.nvmrc pinned) — tsx + @mysten/sui Node 24 ile uyumsuz
- Relayer: ethers v6 + @mysten/sui v1 + tsx

### Conventions
- Conventional commits: type(scope): description
- No Co-authored-by or AI references in commits
- Turkish communication preferred
