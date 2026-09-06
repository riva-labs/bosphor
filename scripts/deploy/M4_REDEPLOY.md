# Milestone 4 breaking redeploy runbook (#395)

> HITL. This stands up the escrow-enabled contracts on testnet and rewires the
> live relayer to the origin-chain payment flow. Run it deliberately, from `main`
> after the M4 PR (#397) is merged, with funded testnet deployer keys. There is no
> on-chain state to migrate: a fresh escrow adapter replaces the M3 adapter.

M4 makes these deploy-time changes versus M3:

1. **New EVM adapter: `BosphorEscrowAdapter`** (replaces `BosphorAdapter`). Same
   constructor `(endpoint, delegate, trustedRelayer)`, but `submitIntent` now
   escrows the `msg.value` surplus above the LZ fee, `_lzReceive` releases the
   escrow on a valid proof, and there are `refund`, `withdraw`, and (opt-in)
   `setPermit2` / `depositUsdcWithPermit2`. Frozen wire formats are unchanged, so
   the Sui/Solana peers and the 81B/49B/97B messages are compatible as-is.
2. **Solana program upgrade (same program id `7RCSzaG9...`).** `submit_intent`
   gains a trailing `escrow_amount` arg and an escrow-vault PDA account;
   `lz_receive` gains the escrow + beneficiary accounts and releases on the proof;
   a new `refund_escrow` instruction is added. `lz_receive_types` returns the two
   extra metas. This is a program upgrade, not a fresh program.
3. **Relayer rewire.** Point the relayer at `EVM_ESCROW_ADAPTER_ADDRESS`, wire an
   `EscrowReader` (reads `getEscrow(intentId)` on EVM / the vault PDA on Solana),
   and set `BREAK_EVEN_GUARD_ENABLED=true` to activate the never-lose-money gate.

## Preconditions

- `main` up to date (has #397 merged).
- `sui client active-env` is `testnet`, funded deployer with testnet SUI + WAL.
- EVM deployer key funded on Sepolia; Solana deployer funded on devnet.
- Use the testnet-guarded wrapper so you never touch mainnet:
  `scripts/util/deploy-testnet.sh <...>` (pins sui CLI to testnet, reads/writes `relayer/.env.testnet`).

## Step 1: Sui packages (unchanged from M3)

The Move packages did not change in M4. Reuse the existing M3 testnet deployment,
or republish per `M3_REDEPLOY.md` Steps 1-3 if starting clean. Confirm
`SUI_LZ_PACKAGE_ID`, `SUI_LZ_OAPP_ID`, `SUI_WALRUS_SYSTEM_ID` are set.

## Step 2: Deploy the EVM escrow adapter

```bash
BOSPHOR_ENV_FILE=relayer/.env.testnet npm run deploy:evm-escrow
```

`deploy-evm-escrow.ts` builds `BosphorEscrowAdapter`, deploys it with the funded
deployer as delegate + trusted relayer (override the beneficiary with
`TRUSTED_RELAYER`), sets the Sui peer when `SUI_LZ_PACKAGE_ID` is set, optionally
wires Permit2 when `PERMIT2_ADDRESS` is set (Sepolia Permit2 is the canonical
`0x000000000022D473030F116dDEE9F6B43aC78BA3`), and writes
`EVM_ESCROW_ADAPTER_ADDRESS`.

## Step 3: Upgrade the Solana program

Rebuild and upgrade the same program id (escrow instructions are additive):

```bash
cd contracts/solana && anchor build
anchor upgrade target/deploy/bosphor_adapter.so \
  --program-id 7RCSzaG9NsK2BNMmLqQ22Zqrf6Te6Wvi5MNpknoit1AF \
  --provider.cluster devnet
```

No new PDAs are pre-created: escrow vault PDAs are created per intent at submit.
Re-run `scripts/solana` `init-store` / `set-peer` only if the store/peer config
was reset.

## Step 4: Rewire peers, DVN, executor  (CRITICAL - learned the hard way 2026-09-06)

The self-built DVN/executor is bound to a specific EVM adapter and does NOT fall
back to LZ defaults (the LZ-Labs Sui-testnet DVN is dead). A fresh adapter has
NO messaging config, so nothing verifies its packets until you wire all of this.
Do it in THIS order, and do NOT flip the Sui receive-peer until the old pathway
is quiet, or in-flight old-adapter messages orphan and head-of-line-block the
DVN's in-order queue (they fail `EOnlyPeer`, code 6, forever).

1. **Stop + repoint the canary FIRST.** The testnet canary submits to the old
   adapter on an interval; leave it running and it keeps generating orphaned
   messages. Stop `bosphor-canary-1`, set its `EVM_ADAPTER_ADDRESS` to the new
   adapter, keep it stopped until the end.
2. **Point the DVN at the new adapter.** Set `EVM_ADAPTER_ADDRESS` = new adapter
   in `bosphor-dvn/.env` (it governs BOTH the forward watch and the return-leg
   verify/execute), then recreate both forward DVN workers (env_file is read at
   container start, so `up -d --force-recreate`, not `restart`).
   **Rewind the EVM forward cursor** (`/data/cursor-evm_sui.json` in the
   `dvn-state` volume) to just before the new adapter's FIRST `PacketSent` block.
   This is MANDATORY whenever the new adapter already emitted any packets before
   the cursor (e.g. earlier failed deploy attempts): the Sui channel clears
   inbound nonces strictly in order, so an unseen early nonce head-of-line-blocks
   every later one with `messaging_channel::clear_payload` abort code 4
   (`EInvalidNonce`) forever. Find the first block with
   `IntentSubmitted` on the new adapter and set the cursor below it.
3. **Set the new adapter's EVM receive-ULN required DVN** to the operator EOA
   (`0x9665…`), matching the old adapter, so return proofs (Sui -> EVM) are
   verifiable. Without this the escrow never releases. Use the helper (dry-run by
   default, `--apply` to broadcast; it mirrors the old adapter's config exactly):
   `BOSPHOR_ENV_FILE=relayer/.env.testnet npx tsx scripts/util/set-evm-receive-uln.ts [--apply]`
3b. **Run the continuous Sui -> EVM RETURN worker** (`dvn-evm-return` in
   `docker-compose.dvn.yml`, `npm run return` + `RUN=1`). CRITICAL and easy to
   miss: the M4 adapter's `confirmExecution` is NON-releasing, so the escrow
   releases ONLY on a genuine LZ `_lzReceive`. The relayer sends the proof via
   `lz_send_proof` on Sui; this worker verifies + `commitVerification` +
   `lzReceive` on Sepolia (EOA `0x9665`) to release it. M3 did not need this (its
   `confirmExecution` released), so it was never containerized before M4. Set
   `RETURN_MIN_NONCE` past the highest already-delivered return nonce to avoid a
   wasted verify tx each poll. For a stuck one-off, `npm run return-one -- <sui-digest>`.
4. **Sui side:** the OApp (`SUI_LZ_OAPP_ID`) is shared, so its send/receive ULN
   already uses our DVN - only the peer changes. Set `sui set_peer(40161, new
   adapter)` LAST, after the old queue is drained. (`npm run wire`.)
5. **EVM -> Sui peer** on the new adapter: set in Step 2 or `npm run wire`.
6. **Solana <-> Sui peers:** unchanged (same program id); re-verify if needed.

If you switched the Sui peer while the old canary was live and wedged the DVN:
stop the canary, restore the Sui peer to the OLD adapter to drain the stuck
messages, then repoint DVN + canary to the new adapter and switch the peer back.

Also run `scripts/util/set-lz-relayer.ts --use-relayer-key` if lz_send_proof
aborts `EUnauthorizedRelayer` (the config authorizes the deployer, not the
operational relayer key).

## Step 5: Rewire the relayer

In `relayer/.env.testnet`:

- `EVM_ADAPTER_ADDRESS=<EVM_ESCROW_ADAPTER_ADDRESS>` (the relayer reads the escrow adapter).
- `BREAK_EVEN_GUARD_ENABLED=true`.
- Confirm `QUOTE_RETURN_LZ_FEE_MIST`, `QUOTE_SUI_GAS_MIST`, `QUOTE_*` buffers,
  and the price-oracle keys (`PYTH_HERMES_API_KEY` or CoinGecko) are set.
- Wire the `EscrowReader` provider (`ESCROW_READER`) to the on-chain `getEscrow`
  read for EVM and the vault PDA read for Solana. Until then the guard stays inert.

Rebuild + restart the testnet relayer image:

```bash
docker build -t bosphor-relayer:testnet ./relayer && docker restart <testnet-relayer>
```

## Step 6: Update canary + monitoring

- Point the canary at `EVM_ESCROW_ADAPTER_ADDRESS`.
- Confirm the new Grafana panels render: `bosphor_relayer_intent_net_margin_usd`,
  `bosphor_relayer_intent_negative_margin_total` (alert: must stay 0),
  `bosphor_relayer_wal_spend_skipped_total`, `bosphor_relayer_processing_latency_seconds`.

## Step 7: End-to-end priced round-trip

```bash
BOSPHOR_ENV_FILE=relayer/.env.testnet npm run test:e2e:priced
```

Verifies, on EVM and Solana: submit-with-payment escrows the surplus, the proof
releases the escrow to the relayer, `withdraw()` pays out, and the refund path
returns the payer after the deadline when no proof lands.

## Rollback

The pre-escrow `BosphorAdapter` deployment and its `EVM_ADAPTER_ADDRESS` remain
valid; revert the relayer env to it and set `BREAK_EVEN_GUARD_ENABLED=false` to
fall back to the M3 flow. The Solana upgrade is forward-only; the added
instructions are unused by the M3 flow, so an M3-config relayer still works.
