# Bosphor Chaos Harness

On-demand failure-injection harness. Each scenario injects one controlled fault
against the running testnet system, observes, and asserts recovery, then a
consolidated recovery report (Markdown + JSON) is written to `reports/`.

It runs on demand, not in CI: the scenarios act on the live testnet deployment,
which makes CI fault-injection brittle.

## Run

```bash
cd chaos
npm install
npm run chaos                       # all scenarios
npm run chaos deadline-expiry-skip  # a named subset
```

Exit code is non-zero if any scenario failed to recover. Reports land in
`chaos/reports/recovery-report-<timestamp>.{md,json}`.

## Scenarios

| Name | Fault injected | Recovery asserted |
|------|----------------|-------------------|
| `relayer-crash-midflight` | Kill the relayer mid-flight | Restarted relayer resumes and fulfills |
| `sui-rpc-outage` | Take Sui RPC down | Fulfills once RPC returns |
| `evm-rpc-outage` | Take EVM RPC down | Fulfills once RPC returns |
| `low-wal-auto-topup` | Drain WAL below the floor | Auto top-up fires and the intent fulfills |
| `walrus-epoch-rollover` | Force a Walrus epoch rollover | SDK cache reset + retry; upload succeeds |
| `gas-spike-canary-skip` | Spike EVM gas | Canary preflight guard skips the paid probe |
| `deadline-expiry-skip` | Submit a past-deadline intent | Intent is skipped, never mis-executed |

## Configuration

Chain reads and intent submission use the same EVM env as the relayer/canary
(`EVM_RPC_URL`, `EVM_ADAPTER_ADDRESS`, `EVM_RELAYER_KEY`, `SUI_EID`). Canary
observations come from `CANARY_METRICS_URL` (default
`http://localhost:9300/metrics`).

Fault injection is host-specific (systemd, docker, iptables), so each destructive
action is a command you supply via an environment variable. An unset command
fails loudly rather than pretending the fault was injected:

| Env var | Purpose | Args |
|---------|---------|------|
| `CHAOS_STOP_RELAYER_CMD` | Stop the relayer process | — |
| `CHAOS_START_RELAYER_CMD` | Start the relayer process | — |
| `CHAOS_SUI_RPC_DOWN_CMD` / `CHAOS_SUI_RPC_UP_CMD` | Block / restore Sui RPC | — |
| `CHAOS_EVM_RPC_DOWN_CMD` / `CHAOS_EVM_RPC_UP_CMD` | Block / restore EVM RPC | — |
| `CHAOS_WAL_BALANCE_CMD` | Print the relayer WAL balance in MIST | — |
| `CHAOS_DRAIN_WAL_CMD` | Drain WAL to a target | `<mist>` |
| `CHAOS_WALRUS_ROLLOVER_CMD` | Force a Walrus epoch rollover | — |
| `CHAOS_SET_GAS_CMD` | Set the observed EVM gas price | `<gwei>` |

Example, using systemd for the relayer:

```bash
export CHAOS_STOP_RELAYER_CMD="systemctl --user stop bosphor-relayer"
export CHAOS_START_RELAYER_CMD="systemctl --user start bosphor-relayer"
```
