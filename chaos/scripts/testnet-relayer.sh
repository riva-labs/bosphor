#!/usr/bin/env bash
#
# Manage an ISOLATED testnet bare relayer used only by the chaos harness.
#
# This is NOT the mainnet relayer (container bosphor-relayer-1). It runs the
# compiled relayer dist as a bare host process on PORT 3399 with an in-memory
# intent store, sourcing relayer/.env.testnet. Its PID is tracked so the chaos
# CHAOS_STOP_RELAYER_CMD / CHAOS_START_RELAYER_CMD can kill and relaunch exactly
# this process, never the mainnet container or the invoking shell.
#
# Usage: testnet-relayer.sh {start|stop|status}
set -euo pipefail

RELAYER_DIR="/home/arb/bosphor/relayer"
PIDFILE="/tmp/bosphor-testnet-relayer.pid"
LOG="/tmp/bosphor-testnet-relayer.log"

running() {
  [ -f "$PIDFILE" ] || return 1
  local pid
  pid="$(cat "$PIDFILE")"
  # Only treat it as ours if the PID is still a live node process. Guards against
  # a recycled PID that now belongs to an unrelated program.
  [ "$(ps -o comm= -p "$pid" 2>/dev/null || true)" = "node" ]
}

start() {
  if running; then
    echo "testnet relayer already running (pid $(cat "$PIDFILE"))"
    return 0
  fi
  cd "$RELAYER_DIR"
  # Exported vars win over the mainnet relayer/.env that @nestjs/config loads,
  # because dotenv does not override already-set process.env. .env.testnet is a
  # superset of .env, so nothing mainnet leaks in.
  set -a
  # shellcheck disable=SC1091
  . ./.env.testnet
  set +a
  export PORT=3399
  export DATABASE_URL=""          # force the in-memory intent store
  nohup node dist/main >>"$LOG" 2>&1 &
  echo $! >"$PIDFILE"
  echo "testnet relayer started (pid $(cat "$PIDFILE"), port 3399)"
}

stop() {
  if [ ! -f "$PIDFILE" ]; then
    echo "no pidfile; nothing to stop"
    return 0
  fi
  local pid
  pid="$(cat "$PIDFILE")"
  if [ "$(ps -o comm= -p "$pid" 2>/dev/null || true)" = "node" ]; then
    kill "$pid"
    echo "killed testnet relayer (pid $pid)"
  else
    echo "pid $pid is not a live node process; skipping kill"
  fi
  rm -f "$PIDFILE"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  status) running && echo "running (pid $(cat "$PIDFILE"))" || echo "not running" ;;
  *)
    echo "usage: $0 {start|stop|status}" >&2
    exit 2
    ;;
esac
