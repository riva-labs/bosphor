# Changelog

## 0.8.0 (2026-09-01)

### Features

- feat(relayer): count return-leg settlement mode in the intent processor
- feat(relayer): add return-mode counter to the metrics service

## 0.7.3 (2026-09-01)

### Bug Fixes

- fix(relayer): validate LZ send worker config before building return PTBs

## 0.7.2 (2026-08-31)

### Bug Fixes

- fix(relayer): catch poll-tick rejections in the EVM lifecycle watcher
- fix(relayer): retry EVM bootstrap with backoff instead of crashing
- fix(relayer): classify the ethers bootstrap discovery failure as transient
- fix(relayer): pin the EVM provider to a static network from config

## 0.7.1 (2026-08-30)

### Bug Fixes

- fix(relayer): record the confirmed hop on the Solana return leg

## 0.7.0 (2026-08-30)

### Features

- feat(relayer): add POST /blob/encode to derive a blob id without storing

## 0.6.0 (2026-08-25)

### Features

- feat(relayer): self-heal missing bytes by re-fetching committed blob from Walrus

## 0.5.2 (2026-08-25)

### Bug Fixes

- fix(relayer): record Sui delivery digest on the received hop

## 0.5.1 (2026-08-24)

### Bug Fixes

- fix(relayer): create staged_intent table on boot (DI token erasure)

## 0.5.0 (2026-08-24)

### Features

- feat(relayer): durable-queue depth gauges + Grafana panels and alerts
- feat(relayer): reaper for expiry/purge + bounded graceful drain

## 0.4.0 (2026-08-24)

### Features

- feat(relayer): drive stores from the durable queue with a single-writer loop
- feat(relayer): durably stage ingested bytes + aggregate backpressure
- feat(relayer): add staged_intent durable store queue table + store

## 0.3.1 (2026-08-20)

### Bug Fixes

- fix(relayer): complete blob store when IntentReceived precedes bytes

## 0.3.0 (2026-08-18)

### Features

- feat(relayer): confirm Solana-origin intents on their origin chain
- feat(relayer): encode confirm_execution for the Solana adapter
- feat(relayer): record submitted hop for Solana-origin intents
- feat(relayer): decode Solana adapter IntentSubmitted events

### Bug Fixes

- fix(relayer): tolerate transient Solana RPC errors in the watcher

## 0.2.1 (2026-08-15)

### Bug Fixes

- fix(relayer): honor BOSPHOR_ENV_FILE for env isolation
- fix(relayer): use canonical big-endian blob id for ingest and return proof

## 0.2.0 (2026-08-11)

### Features

- feat(relayer): intent-aware ingest endpoint and commitment-bound store
- feat(relayer): track on-chain commitment and update execute_store PTB

## [0.1.3](https://github.com/riva-labs/bosphor/compare/relayer-v0.1.2...relayer-v0.1.3) (2026-07-31)

### Bug Fixes

* **relayer:** stop transient RPC blips flooding Sentry as errors ([#226](https://github.com/riva-labs/bosphor/issues/226)) ([1efe14a](https://github.com/riva-labs/bosphor/commit/1efe14a7464debf63e2f79b12bb01ef0796f0531))

## [0.1.2](https://github.com/riva-labs/bosphor/compare/relayer-v0.1.1...relayer-v0.1.2) (2026-07-30)

### Features

* **canary:** alerting, Grafana dashboard, and probe timing fix ([#141](https://github.com/riva-labs/bosphor/issues/141)) ([bf2b293](https://github.com/riva-labs/bosphor/commit/bf2b2932ecdd9ff2feffcebfdee96affc3751fa2))
* **canary:** wallet balance + gas guards and relayer WAL auto top-up ([#145](https://github.com/riva-labs/bosphor/issues/145)) ([870f65c](https://github.com/riva-labs/bosphor/commit/870f65ca721f1aece4925dbcd132f36c77856638))
* **relayer:** extend SuiService with walrus SDK plugin and migrate config ([#102](https://github.com/riva-labs/bosphor/issues/102)) ([a139482](https://github.com/riva-labs/bosphor/commit/a139482f3bb06e8e3f10367865fdc4f1334d7bc6))
* **relayer:** intent lifecycle store + public feed API ([#160](https://github.com/riva-labs/bosphor/issues/160)) ([195e903](https://github.com/riva-labs/bosphor/commit/195e903c0caceaa37f5fc29a42f0c6900dbc16cc))
* **relayer:** migrate Sui transport from JSON-RPC to gRPC ([#96](https://github.com/riva-labs/bosphor/issues/96)) ([ba0667c](https://github.com/riva-labs/bosphor/commit/ba0667cb7bc4ea0618c88174bb8968657044b246))
* **relayer:** migrate WalrusService uploads to SDK writeBlob ([#104](https://github.com/riva-labs/bosphor/issues/104)) ([7805881](https://github.com/riva-labs/bosphor/commit/78058813553ee6743cb33f35b44aebf172e9f10b))
* **relayer:** Prometheus /metrics endpoint + drop premature EVM-path lz_send ([#139](https://github.com/riva-labs/bosphor/issues/139)) ([d6d797e](https://github.com/riva-labs/bosphor/commit/d6d797e291f32fddfd991abb16effd9948740e48)), closes [#138](https://github.com/riva-labs/bosphor/issues/138)
* **relayer:** Sentry runtime error tracking for relayer + canary ([#158](https://github.com/riva-labs/bosphor/issues/158)) ([6c4cafc](https://github.com/riva-labs/bosphor/commit/6c4cafc14c6099d50465ca88574a3eba33df2b38))
* waitlist capture API + CTA page (M2 adoption signals) ([#172](https://github.com/riva-labs/bosphor/issues/172)) ([60133dd](https://github.com/riva-labs/bosphor/commit/60133dd86a314dc7fa69e2233172b49c1074553b))

### Bug Fixes

* **relayer:** make Sui return path reliable end-to-end ([#128](https://github.com/riva-labs/bosphor/issues/128)) ([34ea6a5](https://github.com/riva-labs/bosphor/commit/34ea6a51755982f7bd9008d6d7e8428e7e90043d))
* **relayer:** network-aware WAL coin type (mainnet balance gauge reads 0) ([#187](https://github.com/riva-labs/bosphor/issues/187)) ([00070cc](https://github.com/riva-labs/bosphor/commit/00070cc0eff7bfafce575328ed0f52b11b1b2f58))
* **relayer:** publish SUI balance and init WAL top-up counter every check ([#169](https://github.com/riva-labs/bosphor/issues/169)) ([d513a50](https://github.com/riva-labs/bosphor/commit/d513a5051be820fc8092f782389a46a727bedea2))
* **relayer:** refresh Walrus SDK cache before every upload ([#144](https://github.com/riva-labs/bosphor/issues/144)) ([97c1c38](https://github.com/riva-labs/bosphor/commit/97c1c38fd5f8b464613b99fe8b877ca215b5576f))
* **relayer:** remove findBlobObject dead code ([#105](https://github.com/riva-labs/bosphor/issues/105)) ([9197514](https://github.com/riva-labs/bosphor/commit/919751427f817c43fca8b78dc88c2e187af9eb40))
* **relayer:** stabilization fixes (getLogs head-lag + Walrus tip cap) ([#185](https://github.com/riva-labs/bosphor/issues/185)) ([3211e0b](https://github.com/riva-labs/bosphor/commit/3211e0b4b3cac14f3f508fd35b37f5d928d5abe4))

## [0.1.1](https://github.com/riva-labs/bosphor/compare/relayer-v0.1.0...relayer-v0.1.1) (2026-06-06)

### Features

* **relayer:** migrate Sui transport from JSON-RPC to gRPC ([#96](https://github.com/riva-labs/bosphor/issues/96)) ([ba0667c](https://github.com/riva-labs/bosphor/commit/ba0667cb7bc4ea0618c88174bb8968657044b246))
