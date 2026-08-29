#!/usr/bin/env bash
# Re-apply the Grafana operator conveniences that live in Grafana's own DB (not
# in provisioning): make "Bosphor Mission Control" the home dashboard and expose
# it as a login-free public dashboard. The dashboard JSON itself is provisioned
# (monitoring/grafana/dashboards/), so it always reloads on its own; this script
# only restores the two bits that reset when the Grafana container is recreated
# (it has no persistent volume).
#
# Run it once after any Grafana recreate. Idempotent.
#
# Usage:
#   ./scripts/grafana-apply.sh                       # reads admin pw from the container
#   GRAFANA_URL=http://localhost:3001 GRAFANA_ADMIN_PASSWORD=... ./scripts/grafana-apply.sh
set -euo pipefail

UID_="bosphor-overview"
GRAFANA_URL="${GRAFANA_URL:-http://localhost:3001}"
GRAFANA_USER="${GRAFANA_ADMIN_USER:-admin}"

# Fall back to reading the admin password straight off the running container so
# the operator does not have to know it.
if [ -z "${GRAFANA_ADMIN_PASSWORD:-}" ]; then
  GRAFANA_ADMIN_PASSWORD="$(docker exec bosphor-grafana-1 printenv GF_SECURITY_ADMIN_PASSWORD 2>/dev/null || true)"
fi
if [ -z "${GRAFANA_ADMIN_PASSWORD:-}" ]; then
  echo "error: set GRAFANA_ADMIN_PASSWORD (could not read it from bosphor-grafana-1)" >&2
  exit 1
fi

AUTH="-u ${GRAFANA_USER}:${GRAFANA_ADMIN_PASSWORD}"

echo "==> waiting for Grafana at ${GRAFANA_URL}"
for _ in $(seq 1 30); do
  if curl -fsS $AUTH "${GRAFANA_URL}/api/health" >/dev/null 2>&1; then break; fi
  sleep 2
done

echo "==> setting '${UID_}' as the home dashboard"
curl -fsS $AUTH -X PUT "${GRAFANA_URL}/api/org/preferences" \
  -H 'content-type: application/json' \
  -d "{\"theme\":\"\",\"homeDashboardUID\":\"${UID_}\",\"timezone\":\"\"}" >/dev/null
echo "    done"

echo "==> ensuring the public (login-free) dashboard is enabled"
existing="$(curl -fsS $AUTH "${GRAFANA_URL}/api/dashboards/uid/${UID_}/public-dashboards" 2>/dev/null || true)"
token="$(printf '%s' "$existing" | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')"
if [ -z "$token" ]; then
  created="$(curl -fsS $AUTH -X POST "${GRAFANA_URL}/api/dashboards/uid/${UID_}/public-dashboards" \
    -H 'content-type: application/json' \
    -d '{"isEnabled":true,"timeSelectionEnabled":true,"annotationsEnabled":false}')"
  token="$(printf '%s' "$created" | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')"
fi

if [ -z "$token" ]; then
  echo "error: could not obtain a public-dashboard access token" >&2
  exit 1
fi

echo
echo "Home dashboard : ${GRAFANA_URL}  (opens Bosphor Mission Control)"
echo "Public URL     : https://grafana.bosphor.xyz/public-dashboards/${token}"
echo "                 (login-free, live data; share this to monitor from anywhere)"
