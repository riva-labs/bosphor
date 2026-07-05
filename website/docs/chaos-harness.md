---
sidebar_position: 10
title: Chaos / Failure-Injection Harness
---

# Chaos / Failure-Injection Harness

The chaos harness demonstrates that Bosphor recovers from real resilience failures. Each scenario injects one controlled fault against the running testnet system, observes the system, and asserts that it recovers, then writes a consolidated recovery report you can attach to a status report.

It runs on demand, not in CI: the scenarios act on the live testnet deployment, so running them under CI would be brittle.

## Running

```bash
cd chaos
npm install
npm run chaos                       # run all scenarios
npm run chaos deadline-expiry-skip  # run a named subset
```

The command exits non-zero if any scenario failed to recover, and writes `chaos/reports/recovery-report-<timestamp>.md` and `.json`.

## Scenarios

| Scenario | Fault injected | Recovery asserted |
|----------|----------------|-------------------|
| `relayer-crash-midflight` | Relayer killed mid-flight | Restarted relayer resumes and fulfills the in-flight intent |
| `sui-rpc-outage` | Sui RPC taken down | Intent fulfills once RPC returns |
| `evm-rpc-outage` | EVM RPC taken down | Intent fulfills once RPC returns |
| `low-wal-auto-topup` | Relayer WAL drained below the floor | Auto top-up fires and the intent still fulfills |
| `walrus-epoch-rollover` | Walrus epoch rollover invalidates the SDK cache | Upload resets the cache and retries |
| `gas-spike-canary-skip` | EVM gas price spikes | The canary preflight guard skips the paid probe |
| `deadline-expiry-skip` | Intent submitted past its deadline | The intent is skipped, never mis-executed |

## Configuration

Chain reads and intent submission reuse the relayer/canary EVM environment. Canary observations are read from its `/metrics` endpoint.

Fault injection is host-specific (systemd, docker, iptables), so each destructive action is a shell command you supply through an environment variable. An unset command fails loudly instead of pretending the fault was injected. See `chaos/README.md` for the full list of `CHAOS_*` variables and examples.

The harness does not change relayer fulfillment behaviour; it only submits intents and injects faults through the operator-supplied commands.
