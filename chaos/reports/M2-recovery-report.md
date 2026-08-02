# Bosphor M2 Chaos Recovery Report

Milestone 2, deliverable (a): failure-injection run against an isolated environment,
with recovery evidence. Authored 2026-07-24.

This consolidates the live chaos runs whose machine-generated artifacts sit beside
this file (`recovery-report-<ts>.{md,json}`). All scenarios ran against an isolated
testnet target, never the mainnet stack.

## Test target (isolation)

- **Bare testnet relayer**: compiled relayer dist run as a host process on port 3399
  with an in-memory intent store, sourcing `relayer/.env.testnet` (Sepolia EID 40161,
  Sui testnet EID 40378). Managed by `chaos/scripts/testnet-relayer.sh`.
- **Never touched**: the mainnet relayer container `bosphor-relayer-1`, the mainnet
  canary `bosphor-canary-1`, and the shared host services (Grafana, Prometheus,
  Postgres). Fault injection was wired to the bare process by PID (matching
  `comm == node`), so a stop/start could only ever hit the isolated relayer.
- Wiring entrypoint: `chaos/scripts/run-testnet-chaos.sh`, which sources the testnet
  env and refuses to run if the effective `EVM_RPC_URL` is not Sepolia.

## Results

| Scenario | Result | Evidence |
|----------|--------|----------|
| `deadline-expiry-skip` | PASS (live) | Expired-deadline submit reverted at the adapter on-chain; intent never mis-executed. 8.5s. |
| `relayer-crash-midflight` | Recovery proven; fulfillment gated by external LZ testnet outage | Relayer killed mid-flight, restarted, and resumed from its checkpoint cursor. On-chain fulfillment did not complete because the EVM to Sui message never left LZ (see root cause). |

### deadline-expiry-skip (PASS, live)

Artifact: `recovery-report-1784895638182.{md,json}`.

The harness submitted an intent whose deadline is already in the past. The
`BosphorAdapter` reverted the submit at the on-chain deadline guard, so the intent
was rejected and never mis-executed. This proves the adapter's expiry safety holds
against a real Sepolia submission.

### relayer-crash-midflight (relayer recovery proven; delivery externally blocked)

Artifact: `recovery-report-1784820684292.{md,json}`.

Injected fault: kill the relayer mid-flight, then restart it and expect it to resume
and fulfill the in-flight intent.

What the run proved directly (from `/tmp/bosphor-testnet-relayer.log`):

- The relayer was killed (pid 2550256) and relaunched (pid 2575082).
- On restart it logged `Resuming from checkpoint 363551261` and rebuilt state by
  sequential checkpoint backfill, exactly the resume path we hardened in M1/M2. No
  crash loop, no lost cursor, clean boot on port 3399.

What did not complete: `executed(intentId) == true` on the EVM adapter, because the
submitted message (intent `0x7c8136c8...`, LZ nonce 1934) never left LayerZero.

Root cause (verified against LZ Scan testnet, not assumed):

- The submitted message is `INFLIGHT`, DVN status `WAITING`, destination `WAITING`.
- The pathway backlog behind it is stuck: nonces 1922 to 1930 are `BLOCKED`, 1931 to
  1934 are `WAITING`. Inbound delivery on Sui is ordered, so a fresh intent cannot be
  executed until the pre-existing backlog clears.
- This traces to the sui-testnet DVN outage of 2026-07-08 (LayerZero Labs' sole
  sui-testnet DVN stopped verifying inbound messages), which is the exact external
  failure Milestone 2 mitigated by (1) building a self-operated DVN and (2) proving
  the full pipeline on mainnet with production LayerZero. See the M2 status report.

The relayer-side recovery behavior this scenario exists to verify (restart, resume,
re-process) is demonstrably working. The uncompleted step is downstream cross-chain
delivery on a testnet path that is externally degraded, not a relayer regression.

## Destructive scenarios: available but deliberately not run

The following are implemented in the harness but were not executed here, because their
fault injection is host-wide and would disturb services shared with other projects on
this host. They are safe to run only on a dedicated, disposable host:

- `sui-rpc-outage` / `evm-rpc-outage`: blackhole a chain RPC host-wide (iptables).
- `low-wal-auto-topup`: drains the relayer WAL and depends on a full round-trip to
  confirm fulfillment (same external LZ dependency as crash-midflight on testnet).
- `walrus-epoch-rollover`, `gas-spike-canary-skip`: force a Walrus epoch rollover /
  spike observed gas; the latter also needs a canary to observe.

Their recovery logic is covered by the harness unit tests (20 passing).

## Summary

- 1 scenario passing fully live against real chain state (`deadline-expiry-skip`).
- 1 scenario with relayer crash-recovery proven live (restart + checkpoint resume),
  with final fulfillment gated by the known, mitigated testnet LZ DVN outage.
- The proven production path for full round-trips is mainnet, where the canary has
  completed successful round-trips end to end (see the M2 status report and Grafana
  evidence).
