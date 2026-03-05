# Bosphor — Project Context

Cross-chain intent execution protocol: EVM → LayerZero v2 → Sui/Walrus blob storage → proof back to EVM.

## Current Phase: Phase 2 — Sui LZ OApp Receiver (IN PROGRESS)

### Phase 2 Checklist
- [x] bosphor_lz package scaffold (Move.toml + LZ git deps)
- [x] lz_receiver.move — OApp receiver (init, lz_receive, IntentReceived event)
- [x] ptb_builder.move — executor PTB builder (lz_receive_info, build_lz_receive_ptb)
- [x] Unit tests (3/3 passing)
- [x] Relayer: Sui IntentReceived event polling eklendi
- [ ] Testnet deploy + register_oapp + set_peer
- [ ] EVM setPeer güncelle (Sui OApp adresi)
- [ ] E2E test: LZ Explorer DELIVERED + relayer Sui event → Walrus → execute_store → EVM confirm

## Phase 1 — LayerZero OApp + Hybrid Relayer ✅ TAMAMLANDI

### Phase 1 Checklist
- [x] BosphorAdapter.sol → OApp dönüşümü (OAppSender + OAppReceiver)
- [x] submitIntent: _lzSend ile LayerZero mesaj gönderimi
- [x] _lzReceive: proof alımı (Phase 2'de aktif olacak)
- [x] confirmExecution: hybrid relayer path (backward-compatible)
- [x] _markExecuted: shared validation (IntentNotFound, AlreadyExecuted, DeadlineExpired)
- [x] quote(): LZ fee estimation view function
- [x] EndpointV2Mock: minimal test altyapısı (17/17 test geçiyor)
- [x] Sepolia deploy + setPeer(40327) + E2E doğrulama
- [x] LZ Explorer'da mesaj görünüyor (status: BLOCKED — Sui OApp yok, beklenen)
- [x] Relayer ABI güncellendi

### Deployed Contracts (Testnet)
- **EVM (Sepolia)**: BosphorAdapter OApp `0x3EdcF291ade81640a079069a4d16f1dE4eAbfb74`
- **Sui (Testnet)**: walrus_executor `0x169f0ece587a5b54cf39218cdf5319ba7ecbb7d403b022802f1f329dbee3e596`
- **Sui Config**: `0xec22f6fe13e1cb7bc88c8d2716f3f42853c9a417e6a00e7f7566fc5322821403`
- **LZ Endpoint (Sepolia)**: `0x6EDCE65403992e310A62460808c4b910D972f10f` (EID 40161)
- **Sui Testnet EID**: 40327

### Sui LZ OApp Package
- **Package**: `sui/lz-receiver/` (bosphor_lz)
- **Modules**: lz_receiver (OApp receiver), ptb_builder (executor PTB)
- **Dependencies**: OApp + PtbMoveCall from LZ-v2 git repo
- **Flow**: EVM → LZ → Sui lz_receive → IntentReceived event → Relayer polls Sui → Walrus → execute_store → EVM confirm

## Key Technical Notes

### LayerZero v2
- OApp = OAppSender + OAppReceiver + OAppCore(Ownable)
- LZ-v2 uses OpenZeppelin v4.9.6 (NOT v5 — OAppCore msg.sender-based Ownable)
- Sui testnet EID: 40327 (send library mevcut on Sepolia endpoint)
- LZ TestHelper too complex → minimal EndpointV2Mock kullanılıyor
- Sui LZ packages: OApp `0x04c440985f5deab2fb7f821b3288d93225a3e637cf22dda476809836f0533751`, EndpointV2 `0xabf9629418d997fcc742a5ca22820241b72fb53691f010bc964eb49b4bd2263a`

### Runtime
- Node 22 required (.nvmrc pinned) — tsx + @mysten/sui Node 24 ile uyumsuz
- Relayer: ethers v6 + @mysten/sui v1 + tsx

### Conventions
- Conventional commits: type(scope): description
- No Co-authored-by or AI references in commits
- Turkish communication preferred
