# Bosphor — Project Context

Cross-chain intent execution protocol: EVM → LayerZero v2 → Sui/Walrus blob storage → proof back to EVM.

## Current Phase: Phase 3 — TBD

## Deployment Scripts ✅ TAMAMLANDI

Automated deployment pipeline: `npm run new-deployment`
- `scripts/deploy-sui.ts` — publish + register_oapp + LZ config (libraries + DVN + executor) + set_peer
- `scripts/deploy-evm.ts` — forge build + deploy BosphorAdapter + setPeer
- `scripts/wire.ts` — connect peers on both chains
- `scripts/e2e-test.ts` — intent submit + LZ status polling (15 min timeout)

### Deployed Contracts v5 (Testnet) — ACTIVE
- **EVM (Sepolia)**: BosphorAdapter `0xbC7EF2F021F517d871282C2bb512C741ad2958c3`
- **Sui LZ OApp**: `0xa4420716d875fa323c5d543876d03979607dea3c428818566d25d82fea6f6656`
- **Sui LzReceiverConfig**: `0xea751eeb901093cf8f45532876c12408f0cc627aad570f6112b2dc2ee8d9e432`
- **Sui OApp Object**: `0x9631910c0bc687a74f0b99dd88d2f0033c393aa36735095de8cce67d5eeb27b0`
- **Sui AdminCap**: `0xbc88d0a58cbfb21c4350aadc342b1f0752ae4f4cb9630a447ede3c5390a9212c`
- **Sui MessagingChannel**: `0x1d1058fd590c44154a92282ebaab621aae10df0982466a433e9c9a18fe9c8301`
- **Sui UpgradeCap**: `0x78d61c951680adc3138f140b9b5b14e5dfd03e9394f4ca3b0dc36bb3c9082663`
- **LZ Executor**: ✅ WORKING — DELIVERED on first attempt

## Phase 2 — Sui LZ OApp Receiver ✅ TAMAMLANDI

### Phase 2 Checklist
- [x] bosphor_lz package scaffold (Move.toml + LZ git deps)
- [x] lz_receiver.move — OApp receiver (init, lz_receive, IntentReceived event)
- [x] ptb_builder.move — executor PTB builder (lz_receive_info, build_lz_receive_ptb)
- [x] register_oapp entry function — wraps endpoint register with internal CallCap
- [x] Relayer: Sui IntentReceived event polling eklendi
- [x] Testnet deploy + register_oapp + set_peer
- [x] EVM setPeer güncelle (Sui OApp adresi, EID 40378)
- [x] E2E test: LZ Explorer DELIVERED

## Phase 1 — LayerZero OApp + Hybrid Relayer ✅ TAMAMLANDI

### Deployed Contracts (Testnet)
- **Sui (Testnet)**: walrus_executor `0x169f0ece587a5b54cf39218cdf5319ba7ecbb7d403b022802f1f329dbee3e596`
- **Sui Config**: `0xec22f6fe13e1cb7bc88c8d2716f3f42853c9a417e6a00e7f7566fc5322821403`
- **LZ Endpoint (Sepolia)**: `0x6EDCE65403992e310A62460808c4b910D972f10f` (EID 40161)
- **Sui Testnet EID**: 40378
- **Sui EndpointV2 Object**: `0x2b96537c30c5fa962a1bfb58a168fc17c17f2546c88e2e9252f21ee7d5eff57a`

### Sui LZ OApp Package
- **Package**: `sui/lz-receiver/` (bosphor_lz)
- **Modules**: lz_receiver (OApp receiver + register_oapp), ptb_builder (executor PTB)
- **Dependencies**: OApp + PtbMoveCall from LZ-v2 git repo
- **Flow**: EVM → LZ → Sui lz_receive → IntentReceived event → Relayer polls Sui → Walrus → execute_store → EVM confirm

## Key Technical Notes

### LayerZero v2
- OApp = OAppSender + OAppReceiver + OAppCore(Ownable)
- LZ-v2 uses OpenZeppelin v4.9.6 (NOT v5 — OAppCore msg.sender-based Ownable)
- Sui testnet EID: 40378 (send library mevcut on Sepolia endpoint)
- LZ TestHelper too complex → minimal EndpointV2Mock kullanılıyor
- Sui LZ packages: OApp `0x04c440985f5deab2fb7f821b3288d93225a3e637cf22dda476809836f0533751`, EndpointV2 `0xabf9629418d997fcc742a5ca22820241b72fb53691f010bc964eb49b4bd2263a`
- **EVM setPeer for Sui**: Must use PACKAGE ID (not OApp Object ID) — LZ registers OApps by package
- **OAppInfoV1 format**: lz_receive_info MUST be wrapped in OAppInfoV1::encode() — raw MoveCall bytes cause executor "could not get OApp info" failure
- **sui client publish**: Needs positional arg (not `--path`), `Published.toml` must be removed for fresh deploy
- **waitForTransaction**: Required between consecutive Sui TX's to avoid object version conflicts

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
