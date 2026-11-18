#!/bin/sh
# Dumps every database in BACKUP_TARGETS to R2 once at start, then daily at
# BACKUP_HOUR_UTC. Serves Prometheus metrics on :9310 so a missed or failed
# backup alerts (BosphorBackupStale / BosphorBackupFailed) instead of going quiet.
#
# BACKUP_TARGETS: space-separated host|port|user|password_env|database entries.
# R2 credentials come from RCLONE_CONFIG_R2_* env vars (monitoring/secrets/backup.env).
set -u

BUCKET="${BACKUP_BUCKET:-bosphor-backups}"
RETENTION="${BACKUP_RETENTION:-30d}"
HOUR="${BACKUP_HOUR_UTC:-2}"
METRICS_DIR=/srv
mkdir -p "$METRICS_DIR"
: > "$METRICS_DIR/metrics.tmp"

failures=0
write_metrics() {
  {
    echo "# HELP bosphor_backup_last_success_timestamp_seconds Unix time of the last successful dump, per database."
    echo "# TYPE bosphor_backup_last_success_timestamp_seconds gauge"
    cat "$METRICS_DIR"/last_* 2>/dev/null
    echo "# HELP bosphor_backup_failures_total Failed dump or upload attempts since start."
    echo "# TYPE bosphor_backup_failures_total counter"
    echo "bosphor_backup_failures_total $failures"
  } > "$METRICS_DIR/metrics.tmp" && mv "$METRICS_DIR/metrics.tmp" "$METRICS_DIR/metrics"
}

run_backups() {
  stamp=$(date -u +%Y-%m-%dT%H%M%SZ)
  for t in $BACKUP_TARGETS; do
    host=$(echo "$t" | cut -d'|' -f1); port=$(echo "$t" | cut -d'|' -f2)
    user=$(echo "$t" | cut -d'|' -f3); pwvar=$(echo "$t" | cut -d'|' -f4)
    db=$(echo "$t" | cut -d'|' -f5)
    pw=$(eval "echo \${$pwvar:-}")
    obj="r2:$BUCKET/$db/$db-$stamp.sql.gz"
    if PGPASSWORD="$pw" pg_dump -h "$host" -p "$port" -U "$user" -d "$db" --no-owner --format=plain \
        | gzip -9 | rclone rcat "$obj"; then
      size=$(rclone size --json "$obj" | sed -n 's/.*"bytes":\([0-9]*\).*/\1/p')
      if [ "${size:-0}" -gt 100 ]; then
        echo "bosphor_backup_last_success_timestamp_seconds{db=\"$db\"} $(date +%s)" > "$METRICS_DIR/last_$db"
        echo "[backup] $db ok ($size bytes) -> $obj"
      else
        failures=$((failures + 1)); echo "[backup] $db FAILED: empty object $obj" >&2
      fi
    else
      failures=$((failures + 1)); echo "[backup] $db FAILED: dump or upload error" >&2
    fi
    rclone delete --min-age "$RETENTION" "r2:$BUCKET/$db/" || echo "[backup] $db retention sweep failed" >&2
  done
  write_metrics
}

write_metrics
httpd -p 9310 -h "$METRICS_DIR"
run_backups
while true; do
  now=$(date -u +%s)
  next=$(date -u -d "@$(( (now / 86400) * 86400 + HOUR * 3600 ))" +%s)
  [ "$next" -le "$now" ] && next=$((next + 86400))
  sleep $((next - now))
  run_backups
done
