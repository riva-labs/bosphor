---
sidebar_position: 11
title: Relayer Benchmarks
---

# Relayer Benchmarks

This page reports how fast the Bosphor relayer processes storage intents and how it behaves under concurrent load and faults. Every number below comes from a command shown next to it. Where a number needs live infrastructure, the page gives the command to produce it instead of a value.

## Two latencies, measured separately

The relayer exposes two latency histograms (see [Relayer: latency metrics](relayer.md#latency-metrics-and-the-sub-3s-kpi)):

- **Compute latency** (`bosphor_relayer_compute_latency_seconds`): the store span minus the time spent waiting on external I/O the relayer does not control (Walrus upload relay, Sui `execute_store` and finality wait, LayerZero fee quote and send, WAL top-up, escrow reads, price fetches). This is the relayer's own processing time and the M4 "median relay latency under 3 s" KPI.
- **End-to-end store latency** (`bosphor_relayer_processing_latency_seconds`): the same span with the I/O included. On public testnet each external round-trip takes seconds, so this is I/O-bound and typically 10 to 30 s. It is reported for visibility, not as the KPI.

External I/O is timed per intent by the relayer's I/O clock (`relayer/src/intent/io-clock.ts`). Any call left untimed counts toward compute, so the compute figure can only over-report.

## Methodology: the load generator

`relayer/scripts/loadgen.ts` drives synthetic, ready-to-store intents through the **real** `IntentProcessor` claim loop at a chosen store concurrency. Only these are replaced:

| Replaced | By |
|----------|----|
| Walrus upload, Sui `execute_store` + wait, LayerZero quote + send, WAL top-up | Fakes with a configurable latency (`--walrus-ms`, `--sui-ms`, `--sui-wait-ms`, `--lz-quote-ms`, `--lz-send-ms`, `--wal-topup-ms`) plus seeded jitter (`--jitter-ms`) |
| Postgres durable queue (`staged_intent`) | An in-memory queue with the same interface; `--db-ms` adds a delay to every queue call |

Everything else is production code: the claim tick, the blob-id re-verification against the commitment, the per-step idempotent store, the lifecycle hops, the EVM and Solana return-leg routing, and the metrics service. The compute latency in the tables is captured from the exact `observeComputeLatency` call that feeds the production histogram, so it is the relayer's own accounting, not a separate stopwatch.

What the local run does and does not tell you:

- It measures the relayer's own per-intent processing cost under concurrency, and the throughput the claim loop sustains **given** the stubbed I/O latencies. Those latencies are inputs, not measurements of testnet.
- The production metric is recorded with 1 ms resolution (`Date.now()`), so sub-millisecond work records as `0` or `1`. The mean column shows the average of those samples.
- Postgres is not modelled unless `--db-ms` is set. In production the queue writes are local and are counted as compute, so the `--db-ms` profile below shows how compute grows with queue latency.
- The load generator runs claim ticks back to back. In production a tick starts on an ingest or `IntentReceived` wake, or every 2 s (`CLAIM_INTERVAL_MS`), so a sustained backlog can see up to one poll interval of idle time between ticks. The throughput here is the pipeline's capacity, not the poll cadence.
- A warmup batch (50 intents by default) runs first and is discarded.

## Local results (stubbed I/O, relayer compute)

Measured on 2026-09-24 on an Intel Core i9-9900K (16 threads, shared host, load average about 2 to 5 during the runs), Linux x64, Node v22.22.2, relayer 0.13.2. These are **local measurements of relayer compute with external I/O stubbed**. They are not testnet numbers.

### Profile 1: zero I/O latency (processing ceiling)

All fakes return immediately, so the store span is pure relayer work.

```bash
cd relayer
npx tsx scripts/loadgen.ts --concurrency 1,10,50 --intents 10000
```

| Concurrency | Intents | Failed | Wall (s) | Throughput (intents/s) | Compute mean (ms) | Compute p50 (ms) | Compute p95 (ms) | Compute p99 (ms) | Compute max (ms) | Store span p50 (ms) | Store span p95 (ms) |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 10000 | 0 | 0.68 | 14705.9 | 0.039 | 0.00 | 0.00 | 1.00 | 6.00 | 0.0 | 0.0 |
| 10 | 10000 | 0 | 0.21 | 47619.0 | 0.111 | 0.00 | 1.00 | 1.00 | 2.00 | 0.0 | 1.0 |
| 50 | 10000 | 0 | 0.19 | 51813.5 | 0.517 | 0.00 | 1.00 | 2.00 | 2.00 | 1.0 | 2.0 |

### Profile 2: stubbed I/O latency

Each intent waits on about 125 ms of fixed fake I/O (Walrus 50, Sui 20 + 20, LZ quote 10, LZ send 20, WAL top-up 5) plus up to 10 ms of jitter per call. One intent in five is Solana-origin, so both return-leg paths run.

```bash
cd relayer
npx tsx scripts/loadgen.ts --concurrency 1,10,50 --intents 500 \
  --walrus-ms 50 --sui-ms 20 --sui-wait-ms 20 --lz-quote-ms 10 --lz-send-ms 20 \
  --wal-topup-ms 5 --jitter-ms 10 --solana-share 0.2
```

| Concurrency | Intents | Failed | Wall (s) | Throughput (intents/s) | Compute mean (ms) | Compute p50 (ms) | Compute p95 (ms) | Compute p99 (ms) | Compute max (ms) | Store span p50 (ms) | Store span p95 (ms) |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 500 | 0 | 76.86 | 6.5 | 0.292 | 0.00 | 1.00 | 2.00 | 2.00 | 154.0 | 165.0 |
| 10 | 500 | 0 | 8.24 | 60.7 | 0.166 | 0.00 | 1.00 | 1.00 | 2.00 | 154.0 | 165.0 |
| 50 | 500 | 0 | 1.70 | 294.6 | 0.108 | 0.00 | 1.00 | 1.00 | 2.00 | 154.0 | 166.0 |

### Profile 3: stubbed I/O plus 1 ms per queue call

Same as profile 2, with every durable-queue call delayed by 1 ms to stand in for a local Postgres round-trip (an assumed input). A store makes six queue calls (fetch bytes, persist upload, persist store, free bytes, mark returned, mark done), and those count as compute.

```bash
cd relayer
npx tsx scripts/loadgen.ts --concurrency 1,10,50 --intents 500 \
  --walrus-ms 50 --sui-ms 20 --sui-wait-ms 20 --lz-quote-ms 10 --lz-send-ms 20 \
  --wal-topup-ms 5 --jitter-ms 10 --solana-share 0.2 --db-ms 1
```

| Concurrency | Intents | Failed | Wall (s) | Throughput (intents/s) | Compute mean (ms) | Compute p50 (ms) | Compute p95 (ms) | Compute p99 (ms) | Compute max (ms) | Store span p50 (ms) | Store span p95 (ms) |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 500 | 0 | 80.77 | 6.2 | 7.254 | 7.00 | 9.00 | 9.00 | 10.00 | 161.0 | 172.0 |
| 10 | 500 | 0 | 8.61 | 58.1 | 6.996 | 7.00 | 9.00 | 9.00 | 10.00 | 160.0 | 172.0 |
| 50 | 500 | 0 | 1.77 | 282.5 | 7.622 | 8.00 | 9.00 | 10.00 | 11.00 | 161.0 | 172.0 |

### Reading the results

- **Relayer compute is small next to the 3 s budget.** Without queue latency, compute stays at or below 2 ms at p99 up to 50 concurrent stores (one 6 ms outlier at concurrency 1 in profile 1). With 1 ms per queue call it is 7 to 8 ms at p50 and at most 11 ms, still orders of magnitude under 3 s.
- **Concurrency does not inflate compute.** Going from 1 to 50 concurrent stores leaves the compute percentiles flat in profiles 2 and 3, because the stores overlap on I/O waits rather than competing for the event loop.
- **Throughput is I/O-bound and scales with store concurrency.** With about 155 ms of stubbed I/O per intent, throughput tracks `concurrency / store span`: 6.5, 60.7, and 294.6 intents/s at 1, 10, and 50. The production default is `STORE_CONCURRENCY=4`; raising it is the throughput lever once real I/O latency is known.
- **End-to-end latency is set by the chains.** The store span column is essentially the stubbed I/O. On testnet the same span is dominated by Walrus, Sui finality, and LayerZero, which is why the end-to-end gauge sits in the 10 to 30 s range while compute stays small.

To reproduce, run the commands above. Add `--out-json <file>` and `--out-md <file>` to save the raw results, and `--help` for every option.

## Live testnet measurement

Live numbers come from a running relayer's own histograms, never from the local run. The Grafana relayer dashboard's "Relayer compute latency p50 / p95" panel plots `bosphor_relayer_compute_latency_seconds` continuously, with the end-to-end p50 alongside for context.

To capture a report for a fixed window, point the load generator at the relayer's Prometheus endpoint. It scrapes `/metrics` at the start and end of the window and reports quantiles and throughput for only the intents completed inside it:

```bash
cd relayer
npx tsx scripts/loadgen.ts --live --metrics-url <relayer /metrics URL> --window-s 1800 \
  --out-json live.json --out-md live.md
```

Load comes from real clients (the canary, the dApp, or the e2e scripts). To add load during the window, pass `--drive "<command>" --drive-count N`, which starts N copies of the command at once. Each copy must use its own wallet, or their nonces collide.

For the all-time quantiles since the relayer started:

```bash
BENCH_METRICS_URL=<relayer /metrics URL> npm --prefix relayer run bench
```

Results: not yet recorded. Run the commands above against the testnet relayer and paste the markdown table here with the date, window, and relayer version.

## Fault tolerance

Throughput numbers only matter if the relayer never loses or double-pays for an intent under faults. These guarantees come from the durable store queue (see [Relayer: durable store queue](relayer.md#durable-store-queue)):

| Mechanism | What it guarantees |
|-----------|--------------------|
| Durable Postgres queue (`staged_intent`) | Accepted bytes live in the database, one row per intent, so a crash never loses them |
| Claim lease (`claimed_by`, `lease_expires_at`, `FOR UPDATE SKIP LOCKED`) | Concurrent relayer processes get disjoint rows; a crashed holder's rows become claimable again after the lease (10 min default) |
| Per-step idempotency (`walrus_object_id`, `store_digest`, `returned`) | A retry re-runs only unfinished steps: never a second Walrus upload (no double WAL spend) or a second Sui record |
| Per-attempt timeout (`STORE_ATTEMPT_TIMEOUT_MS`) | A hung call is abandoned and rescheduled; the in-process slot is held until it truly settles, so it is never driven twice at once |
| Pre-store retry cap (`MAX_STORE_ATTEMPTS`, exponential backoff) | A blob that cannot be stored is dead-lettered after the cap, bytes freed, `bosphor_relayer_store_dead_letter_total{phase="pre_store"}` incremented |
| Return-leg retry cap (`RETURN_MAX_ATTEMPTS`) | Once the blob is stored, the proof return retries up to the cap, then only the return is dead-lettered (`phase="return"`). Storage is never lost, and the origin escrow refunds the payer after its deadline |
| Break-even guard (M4, `BREAK_EVEN_GUARD_ENABLED`) | Before any WAL spend, the relayer checks that the escrow covers the live cost; if not it skips, and the payer is refunded on-chain |
| Backpressure (`MAX_STAGED_BYTES`) | Ingest returns `503` with `Retry-After` instead of buffering without bound |
| Byte recovery | An intent whose client never delivered its bytes is re-fetched from Walrus by its commitment and stored anyway |

The [chaos harness](chaos-harness.md) exercises these paths against the running testnet system (relayer crash mid-flight, Sui and EVM RPC outages, low WAL, Walrus epoch rollover, gas spikes, deadline expiry) and writes a recovery report per run. The unit suite (`cd relayer && npx jest src/intent`) covers the retry classification, dead-lettering, and idempotent resume paths directly.

## Related

- [Multi-chain testing](multichain-testing.md) for gas, compute-unit, and fee-abstraction results
- [Relayer](relayer.md) for configuration and metrics
- [Chaos harness](chaos-harness.md) for failure injection
