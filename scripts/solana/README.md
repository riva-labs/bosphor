# Solana adapter devnet deploy + LayerZero wiring (M3 #242)

Operational toolchain for deploying the Bosphor Solana adapter to devnet and
wiring it as a LayerZero v2 OApp for the Solana <-> Sui reference round-trip.
Not published; run with `tsx` from this directory.

## Constraint that shapes the design

The LayerZero **Sui-testnet DVN and executor are dead**. Every leg whose
verification/execution lands on **Sui** must go through our self-operated DVN
(`bosphor-dvn`) and self-execution, never LZ infra. Concretely:

- **Forward (Solana -> Sui):** verify + execute on Sui -> reuse the existing
  `bosphor-dvn` Sui `verify`/`commit`/self-`lz_receive` path; add a Solana
  forward-packet watcher as a new source.
- **Return (Sui -> Solana):** verify + execute on Solana -> extend `bosphor-dvn`
  with a Solana-side `uln::verify` and a self-executor that delivers `lz_receive`
  on Solana. (LZ's Solana devnet DVN/executor are live and are the fallback if
  the extension proves too heavy, but we self-operate for independence.)

## Confirmed addresses

| Thing | Address |
|-------|---------|
| Bosphor adapter (program) | `7RCSzaG9NsK2BNMmLqQ22Zqrf6Te6Wvi5MNpknoit1AF` |
| LZ endpoint | `76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6` |
| LZ ULN302 (send+recv) | `7a4WjyR8VZ7yZz5XJAKm39BUGn5iT9CKcv2pmG9tdXVH` |
| LZ executor | `6doghB248px58JSSwG4qejQ46kFMW4AMj7vzJnWZHNZn` |
| LZ DVN program | `HtEYV4xB4wvsj5fgTkcfuChYpvGYzgzwvNhgDZQNh7wW` |
| Sui testnet EID | `40378` |
| Solana devnet EID | `40168` (confirm before wiring the reciprocal Sui peer) |

All four LZ programs are verified executable on devnet.

## Prerequisites

1. **Devnet payer, funded.** Default keypair `~/.config/solana/bosphor-devnet.json`
   (override with `SOLANA_KEYPAIR`). Deploying the ~375 KB program needs ~2.9 SOL
   plus headroom; fund with ~4-5 devnet SOL via https://faucet.solana.com when the
   CLI faucet is rate-limited. NEVER the mainnet root wallet.
2. Toolchain: `solana` 3.1.10, `anchor` 0.32.1 (`avm use 0.32.1`), with
   `$HOME/.local/share/solana/install/releases/3.1.10/solana-release/bin` first on
   PATH. Build the `.so` with `anchor build --no-idl` (default anchor build fails
   only in IDL gen).
3. `npm install` in this directory.

## Deploy + wire sequence

```bash
# 0. Deploy the program (.so is prebuilt at solana/target/deploy/)
solana program deploy ../../solana/target/deploy/bosphor_adapter.so \
  --program-id ../../solana/target/deploy/bosphor_adapter-keypair.json \
  --url devnet

# 1. Create the Store (OApp) PDA + register with the endpoint
npm run init-store

# 2. Point send (dst Sui) + receive (src Sui) libraries at ULN302   [TODO]
npm run set-libraries

# 3. ULN send/receive config: required DVN = our self-DVN, executor  [TODO]
npm run set-config

# 4. set_peer(40378, <sui_receiver_32b>) here + reciprocal Sui peer   [TODO]
#    (Sui side maps Solana EID 40168 -> Store PDA, 32 bytes)
npm run set-peer

# 5. Quote + submit a real intent, then drive the self-DVN both ways  [TODO]
npm run roundtrip
```

## Status

- [x] `config.ts` shared config, PDA derivations (match on-chain seeds), payer/RPC
- [x] `init-store.ts` (register_oapp CPI accounts via LZ SDK) - typechecks
- [ ] `set-libraries.ts`, `set-config.ts`, `set-peer.ts`, `quote-send.ts`,
      `roundtrip.ts` (built + validated live once the wallet is funded)
- [ ] `bosphor-dvn` Solana-leg extension (forward watcher + Solana `uln::verify` +
      self-executor)

Instruction encoders for our program (`encodeInitStoreData`, `encodeSetPeerData`,
`encodeSubmitIntentData`) are reused from `sdk/src/solana/program.ts` (single
source of truth, discriminators pinned to the compiled program).
