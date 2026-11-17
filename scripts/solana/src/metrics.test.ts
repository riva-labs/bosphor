/**
 * The Solana return worker's metrics must use the DVN workers' names and the
 * pathway default label, so the existing bosphor-dvn alerts apply to it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createReturnMetrics } from "./metrics.ts";

test("exposes the shared DVN metric names under pathway=sui_solana", async () => {
  const m = createReturnMetrics("sui_solana");
  m.selfHeal.inc({ kind: "gap", result: "delivered" });
  m.selfHeal.inc({ kind: "stranded", result: "abandoned" });
  m.errors.inc({ stage: "deliver" });
  m.lastSuccess.set(1_700_000_000);
  const body = await m.registry.metrics();
  assert.match(body, /bosphor_dvn_self_heal_total\{kind="gap",result="delivered",pathway="sui_solana"\} 1/);
  assert.match(body, /bosphor_dvn_self_heal_total\{kind="stranded",result="abandoned",pathway="sui_solana"\} 1/);
  assert.match(body, /bosphor_dvn_errors_total\{stage="deliver",pathway="sui_solana"\} 1/);
  assert.match(body, /bosphor_dvn_last_success_timestamp_seconds\{pathway="sui_solana"\} 1700000000/);
  // BosphorDvnStale joins on process_start_time_seconds.
  assert.match(body, /process_start_time_seconds\{pathway="sui_solana"\}/);
});

test("serves /metrics and /health over HTTP", async () => {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));

  const m = createReturnMetrics("sui_solana");
  const server = m.serve(port);
  await new Promise((r) => server.once("listening", r));
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.deepEqual(await health.json(), { status: "ok", pathway: "sui_solana" });
  const metrics = await fetch(`http://127.0.0.1:${port}/metrics`);
  assert.equal(metrics.status, 200);
  assert.match(await metrics.text(), /bosphor_dvn_last_success_timestamp_seconds/);
  await new Promise<void>((r) => server.close(() => r()));
});
