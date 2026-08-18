# Milestone 3 breaking redeploy runbook (#240)

> HITL. This changes the live testnet addresses. Run it deliberately, from `main`
> after the M3 PRs (#237, #238, #239, #241) are merged, with a funded testnet
> deployer key. There is no on-chain state to migrate: the dedup tables are
> historical and the Milestone 2 mainnet proof is preserved as a record.

M3 makes three deploy-time changes versus M2:

1. **Two coordinated Sui packages.** `executor` (`contracts/sui/executor`, the
   `walrus_executor` module) now **depends on** `bosphor_lz` (`contracts/sui/lz-receiver`).
   They must be published in order, executor pinned to the freshly published
   `bosphor_lz`, because `execute_store` reads `LzReceiverConfig` across the
   package boundary and the type is keyed by the `bosphor_lz` package id.
2. **A new shared object in the executor PTB.** `execute_store` now takes the
   Walrus `System` object, so the relayer needs `SUI_WALRUS_SYSTEM_ID`.
3. **New EVM adapter interface.** `submitIntent` takes the commitment fields and
   the forward message is `intentId ++ commitment`. The constructor is unchanged.

## Preconditions

- `main` checked out and up to date (has #237/#238/#239/#241).
- `sui client active-env` is `testnet`; `sui client active-address` is the funded deployer; enough testnet SUI + WAL.
- EVM deployer key funded on Sepolia.
- Use the testnet-guarded wrapper for every step so you never touch mainnet:
  `scripts/util/deploy-testnet.sh <deploy:sui|deploy:evm|wire|test:e2e>` (it pins the sui CLI to testnet and reads/writes `relayer/.env.testnet`).

## Step 1: Publish `bosphor_lz` (fresh)

```bash
scripts/util/deploy-testnet.sh deploy:sui
```

`deploy-sui.ts` removes `contracts/sui/lz-receiver/Published.toml`, publishes fresh, runs
`register_oapp`, sets the LZ libraries + DVN/executor config, sets the Sui->EVM
peer if `EVM_ADAPTER_ADDRESS` is already set (it is not on a fresh redeploy; the
peer is set later in Step 6), and writes these to `relayer/.env.testnet`:
`SUI_LZ_PACKAGE_ID`, `SUI_LZ_CONFIG_ID`, `SUI_LZ_OAPP_ID`, `SUI_LZ_ADMIN_CAP_ID`,
`SUI_LZ_MESSAGING_CHANNEL`, `SUI_LZ_UPGRADE_CAP`.

Publishing writes the new package id into `contracts/sui/lz-receiver/Move.lock` under the
`testnet` env. Step 2 relies on this so the executor links against the package
you just published.

## Step 2: Publish `executor`, pinned to the new `bosphor_lz`

> This package has no deploy script yet. Publish it manually, AFTER Step 1, in
> the same `sui client` testnet env, so its `bosphor_lz = { local = "../lz-receiver" }`
> dependency resolves to the just-published `bosphor_lz` (from that package's
> `Move.lock`). Do NOT reorder these two publishes.

```bash
# Fresh publish of the executor package.
rm -f contracts/sui/executor/Published.toml
sui client publish contracts/sui/executor --gas-budget 500000000 \
  --skip-dependency-verification --json | tee /tmp/exec-publish.json
```

From the output, capture:
- the `published` change `packageId` -> `SUI_PACKAGE_ID`
- the created object whose type ends in `::walrus_executor::ExecutorConfig` -> `SUI_CONFIG_ID`

```bash
jq -r '.objectChanges[] | select(.type=="published") | .packageId' /tmp/exec-publish.json   # SUI_PACKAGE_ID
jq -r '.objectChanges[] | select(.objectType? and (.objectType|test("::walrus_executor::ExecutorConfig$"))) | .objectId' /tmp/exec-publish.json  # SUI_CONFIG_ID
```

Sanity check the linkage: the executor's on-chain dependency on `bosphor_lz`
must equal the `SUI_LZ_PACKAGE_ID` from Step 1. If it does not, the `bosphor_lz`
`Move.lock` was stale; re-run Step 1 then Step 2.

## Step 3: Point the executor at the relayer

`init` sets the executor relayer to the publisher. If the relayer signing key
differs from the deployer, update it:

```bash
sui client call --package $SUI_PACKAGE_ID --module walrus_executor \
  --function update_relayer --args $SUI_CONFIG_ID <relayer_address> \
  --gas-budget 20000000
```

## Step 4: Set `SUI_WALRUS_SYSTEM_ID`

`execute_store` reads the current epoch from the Walrus `System` shared object.
Set `SUI_WALRUS_SYSTEM_ID` to the Walrus **testnet** System object id. Obtain it
from the Walrus testnet published config (the `@mysten/walrus` testnet package
config `systemObjectId`, or the Walrus docs / `walrus info` for the active
testnet deployment). Do not guess it; a wrong id makes every `execute_store`
abort. Record it in `relayer/.env.testnet`.

## Step 5: Redeploy the EVM adapter

```bash
scripts/util/deploy-testnet.sh deploy:evm
```

Writes the new `EVM_ADAPTER_ADDRESS`. The constructor is unchanged
(`endpoint`, `delegate`, `trustedRelayer`).

## Step 6: Wire the peers

```bash
scripts/util/deploy-testnet.sh wire
```

- EVM `setPeer` targets the new `bosphor_lz` **PACKAGE ID** (not the OApp object).
- Sui `set_peer` targets the new `EVM_ADAPTER_ADDRESS`.

## Step 7: DVN / ULN receive config

Ensure the ULN receive config points at the self-operated DVN (see
`scripts/util/set-dvn.ts` and the canary DVN work). If you deploy with
`LZ_USE_DEFAULT_DVNS=true` (the wrapper's default), confirm the default DVN is
live for the sui-testnet leg before relying on it.

## Step 8: Update relayer + canary env, restart

Confirm `relayer/.env.testnet` now has, all from the steps above:
`SUI_PACKAGE_ID`, `SUI_CONFIG_ID`, `SUI_LZ_PACKAGE_ID`, `SUI_LZ_CONFIG_ID`,
`SUI_LZ_OAPP_ID`, `SUI_WALRUS_SYSTEM_ID`, `EVM_ADAPTER_ADDRESS`, and the M3
ingest knob `MAX_INGEST_BLOB_BYTES` (default 10485760). Restart the relayer so
it binds the ingest endpoint and the new addresses. Update the canary env with
the same new addresses.

## Step 9: End-to-end validation

> `scripts/test/e2e-test.ts` predates the reference flow. It must be updated to
> the M3 path before it can pass: compute the blob id client-side, call the new
> `submitIntent(blobId, size, encodingType, storageEpochs, deadline, options)`,
> `POST` the bytes to the relayer `POST /blob/:intentId`, then await the proof.
> The `@bosphor/sdk` `store()` call does exactly this and is the intended basis
> for the updated e2e. This is the remaining piece of #239's acceptance.

```bash
scripts/util/deploy-testnet.sh test:e2e
```

Success criteria: an intent submitted on Sepolia is delivered to Sui, the bytes
are ingested out-of-band, stored on Walrus, `execute_store` asserts the blob id
+ funding, the proof returns, and the EVM adapter marks it executed. Confirm the
LayerZero fee is the same for a small and a large file (the flat-cost result).

## Rollback

There is no state migration to undo. If the redeploy misbehaves, the previous
addresses remain valid on-chain; revert `relayer/.env.testnet` to the backup and
restart. Keep a copy of the pre-redeploy `.env.testnet` before Step 1.

## Docs

After the redeploy, update `CLAUDE.md` "Deployed Contracts" and
`website/docs/changelog.md` with the new v6 addresses.
