#!/usr/bin/env bash
#
# Run the chaos harness against the ISOLATED testnet bare relayer (port 3399),
# never the mainnet stack. Sources relayer/.env.testnet so every chain read and
# the intent submission target Sepolia + Sui testnet, and wires the relayer
# stop/start fault-injection to the bare-process manager.
#
# Usage: run-testnet-chaos.sh [scenario-name ...]
set -euo pipefail

REPO="/home/arb/bosphor"

# Testnet env wins over the mainnet root .env that chaos/main.ts loads, because
# dotenv never overrides an already-exported var.
set -a
# shellcheck disable=SC1091
. "$REPO/relayer/.env.testnet"
set +a

# Hard guard: refuse to run if the effective EVM RPC is not Sepolia.
case "${EVM_RPC_URL:-}" in
  *sepolia*) : ;;
  *) echo "REFUSING: EVM_RPC_URL is not Sepolia ($EVM_RPC_URL)" >&2; exit 3 ;;
esac

export CHAOS_STOP_RELAYER_CMD="$REPO/chaos/scripts/testnet-relayer.sh stop"
export CHAOS_START_RELAYER_CMD="$REPO/chaos/scripts/testnet-relayer.sh start"

echo "[run-testnet-chaos] EVM_RPC_URL=$EVM_RPC_URL SUI_EID=${SUI_EID:-}"
echo "[run-testnet-chaos] scenarios: ${*:-<all>}"

cd "$REPO/chaos"
exec npm run chaos -- "$@"
