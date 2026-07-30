#!/usr/bin/env bash
#
# Run a deploy/wire/e2e step against TESTNET only, using relayer/.env.testnet for
# both reads and writes (never the live root .env / mainnet). Hard-refuses if the
# effective RPCs are not testnet, and pins the sui CLI to the testnet env.
#
# Usage: deploy-testnet.sh <deploy:sui|deploy:evm|wire|test:e2e>
set -euo pipefail

REPO="/home/arb/bosphor"
ENV_FILE="$REPO/relayer/.env.testnet"

# Guard: verify the target env is testnet before doing anything.
SUI_URL=$(grep -E '^SUI_GRPC_URL=' "$ENV_FILE" | head -1 | cut -d= -f2-)
EVM_URL=$(grep -E '^EVM_RPC_URL=' "$ENV_FILE" | head -1 | cut -d= -f2-)
case "$SUI_URL" in *mainnet*) echo "REFUSING: SUI_GRPC_URL is mainnet ($SUI_URL)"; exit 3;; esac
case "$EVM_URL" in *sepolia*|*testnet*) : ;; *) echo "REFUSING: EVM_RPC_URL is not Sepolia ($EVM_URL)"; exit 3;; esac

export BOSPHOR_ENV_FILE="$ENV_FILE"
export LZ_USE_DEFAULT_DVNS=true   # use LayerZero's endpoint-default (active LZ Labs) DVN

echo "[deploy-testnet] env=$ENV_FILE"
echo "[deploy-testnet] SUI=$SUI_URL EVM=$EVM_URL LZ_USE_DEFAULT_DVNS=$LZ_USE_DEFAULT_DVNS"

# Pin the sui CLI to testnet so `sui client publish` targets testnet.
sui client switch --env testnet >/dev/null 2>&1 || true
echo "[deploy-testnet] sui active-env: $(sui client active-env 2>/dev/null)"

cd "$REPO"
exec npm run "$1"
