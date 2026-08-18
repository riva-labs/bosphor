# Solana adapter devnet deploy + LayerZero wiring (M3 #242)

Operational toolchain for deploying the Bosphor Solana adapter to devnet and
wiring it as a LayerZero v2 OApp for the Solana -> Sui reference flow. Not
published; run with `tsx` from this directory.

## Design

The LayerZero **Sui-testnet DVN and executor are dead**, so every leg whose
verification/execution lands on **Sui** goes through our self-operated DVN
(`bosphor-dvn`), never LZ infra.

- **Forward (Solana -> Sui):** the DVN reconstructs the LZ packet from the
  adapter's `IntentSubmitted` event and verifies+commits+self-executes it on Sui,
  emitting `IntentReceived`. The relayer then stores the blob on Walrus and runs
  `execute_store`. Proven end-to-end on devnet.
- **Return (Sui -> Solana):** owner-gated `confirm_execution` on the adapter (the
  mirror of the EVM adapter's `confirmExecution`), because the Sui `lz_send_proof`
  send is blocked upstream (#272). `lz_receive` stays the primary path for when
  #272 clears.

The DVN-side and Sui-side wiring for this pathway live in the separate
`bosphor-dvn` repo (`src/solana-source.ts`, `src/main-solana.ts`, and the
`*-solana.ts` Sui config scripts).

## Confirmed addresses

| Thing | Address |
|-------|---------|
| Bosphor adapter (program) | `7RCSzaG9NsK2BNMmLqQ22Zqrf6Te6Wvi5MNpknoit1AF` |
| Store (OApp) PDA | `Gn2Lib6i7iqEibZRjvp3pcDm8cJfCHgTDF9Aek1XnPrE` |
| LZ endpoint | `76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6` |
| LZ ULN302 (send+recv) | `7a4WjyR8VZ7yZz5XJAKm39BUGn5iT9CKcv2pmG9tdXVH` |
| LZ executor | `6doghB248px58JSSwG4qejQ46kFMW4AMj7vzJnWZHNZn` |
| LZ DVN program | `HtEYV4xB4wvsj5fgTkcfuChYpvGYzgzwvNhgDZQNh7wW` |
| Sui testnet EID | `40378` |
| Solana devnet EID | `40168` |
| Sui receiver (peer) | Sui `bosphor_lz` package `0xbaa795...543efee5` |

All four LZ programs are verified executable on devnet.

## Prerequisites

1. **Devnet payer, funded.** Default keypair `~/.config/solana/bosphor-devnet.json`
   (override with `SOLANA_KEYPAIR`). Deploying the ~375 KB program needs ~2.9 SOL
   plus headroom; fund via https://faucet.solana.com when the CLI faucet is rate
   limited. NEVER the mainnet root wallet.
2. Toolchain: `solana` 3.1.10, `anchor` 0.32.1 (`avm use 0.32.1`), with
   `$HOME/.local/share/solana/install/releases/3.1.10/solana-release/bin` first on
   PATH. Build the `.so` with `anchor build --no-idl` (default anchor build fails
   only in IDL gen).
3. `npm install` in this directory.

## Deploy + wire sequence

```bash
# 0. Deploy (or upgrade) the program (.so at solana/target/deploy/)
solana program deploy ../../solana/target/deploy/bosphor_adapter.so \
  --program-id ../../solana/target/deploy/bosphor_adapter-keypair.json \
  --keypair ~/.config/solana/bosphor-devnet.json --url devnet

# 1. Create the Store (OApp) PDA + register with the endpoint
npm run init-store

# 2. Point send (dst Sui 40378) + receive (src Sui 40378) libraries at ULN302
npm run set-libraries

# 3. set_peer(40378, Sui package id). The reciprocal Sui-side wiring
#    (peer 40168 -> Store PDA, receive lib + config) lives in bosphor-dvn:
#    set-peer-sui-solana / set-receive-library-solana / set-receive-config-solana
npm run set-peer

# 4. Submit a storage intent (forward leg -> PacketSent). DATA mode computes the
#    real Walrus blob id and saves the bytes to /tmp/solana-rt.json.
DATA="hello bosphor" NATIVE_FEE=8000000 npm run submit-intent

# 5. Drive the DVN forward leg in bosphor-dvn (npm run start-solana) so the packet
#    is verified+committed+executed on Sui -> IntentReceived.

# 6. Upload the blob bytes to the relayer so it stores to Walrus + execute_store.
RELAYER_URL=http://localhost:3456 npm run roundtrip-upload
```

Note: no Solana-side ULN send config is needed for the forward leg. The default
send config prices the executor + DVN fees; `submit-intent` quotes and pays them.
The DVN set that actually secures the message is enforced by the **Sui** receive
config, wired in `bosphor-dvn`.

## Status

- [x] Deploy + `init-store` + `set-libraries` + `set-peer` (applied live)
- [x] `submit-intent` forward send (real messages Solana -> Sui, proven)
- [x] Forward leg end-to-end: DVN verify+commit+self-execute -> `IntentReceived`
- [ ] `roundtrip-upload` execute_store: blocked on relayer Solana-origin support
      (relayer records the commitment only from EVM `IntentSubmitted`; a Solana
      submit watcher is needed so `getCommitment` resolves)
- [ ] Return leg: program upgrade adds `confirm_execution` (needs devnet SOL for
      the upgrade buffer), then relayer/owner confirms the proof

Instruction encoders for our program (`encodeInitStoreData`, `encodeSetPeerData`,
`encodeSubmitIntentData`, `encodeConfirmExecutionData`) are reused from
`sdk/src/solana/program.ts` (single source of truth, discriminators pinned).
