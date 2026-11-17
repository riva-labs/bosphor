/**
 * Prometheus metrics for the Sui -> Solana return worker (solana-return.ts).
 *
 * Same metric names and the same `pathway` default label as the DVN workers in
 * bosphor-dvn (src/metrics.ts), so the existing bosphor-dvn alerts and
 * dashboards cover this leg too. The load-bearing signal is
 * `bosphor_dvn_last_success_timestamp_seconds`: when it goes stale, escrow
 * releases on this pathway have stopped.
 */
import { createServer, type Server } from "node:http";
import { Counter, Gauge, Registry, collectDefaultMetrics } from "prom-client";

export interface ReturnMetrics {
  registry: Registry;
  /** New return packets attempted. */
  packetsSeen: Counter;
  /** lz_receive delivery attempts, by result. */
  execute: Counter<"result">;
  /** Unix time of the last delivered packet (dead-man's switch). */
  lastSuccess: Gauge;
  /** Errors by stage. */
  errors: Counter<"stage">;
  /** Nonce self-heal actions, by kind (gap|stranded) and result. */
  selfHeal: Counter<"kind" | "result">;
  /** Start the /metrics + /health HTTP server. */
  serve(port: number): Server;
}

export function createReturnMetrics(pathway: string): ReturnMetrics {
  const registry = new Registry();
  registry.setDefaultLabels({ pathway });
  collectDefaultMetrics({ register: registry });

  const packetsSeen = new Counter({
    name: "bosphor_dvn_packets_seen_total",
    help: "New LayerZero packets observed on the source",
    registers: [registry],
  });
  const execute = new Counter({
    name: "bosphor_dvn_execute_total",
    help: "lz_receive self-execute attempts, by result",
    labelNames: ["result"] as const,
    registers: [registry],
  });
  const lastSuccess = new Gauge({
    name: "bosphor_dvn_last_success_timestamp_seconds",
    help: "Unix time of the last fully delivered packet",
    registers: [registry],
  });
  const errors = new Counter({
    name: "bosphor_dvn_errors_total",
    help: "Errors by stage",
    labelNames: ["stage"] as const,
    registers: [registry],
  });
  const selfHeal = new Counter({
    name: "bosphor_dvn_self_heal_total",
    help: "Return-pathway nonce self-heal actions, by kind (gap|stranded) and result",
    labelNames: ["kind", "result"] as const,
    registers: [registry],
  });

  return {
    registry,
    packetsSeen,
    execute,
    lastSuccess,
    errors,
    selfHeal,
    serve(port: number): Server {
      return createServer((req, res) => {
        if (req.url === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", pathway }));
          return;
        }
        if (req.url === "/metrics") {
          registry
            .metrics()
            .then((body) => {
              res.writeHead(200, { "Content-Type": registry.contentType });
              res.end(body);
            })
            .catch((err) => {
              res.writeHead(500);
              res.end(String(err));
            });
          return;
        }
        res.writeHead(404);
        res.end("not found");
      }).listen(port, () => {
        console.log(`[dvn:${pathway}] /metrics on :${port}`);
      });
    },
  };
}
