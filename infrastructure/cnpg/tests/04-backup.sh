#!/usr/bin/env bash
# Test case: on-demand backup via the Barman Cloud plugin reaches phase: completed.
# Not destructive to the live cluster (creates a Backup object + blob data).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./00-common.sh

[ "$(cluster_phase)" = "Cluster in healthy state" ] || fail "cluster is not healthy (phase: $(cluster_phase)) — fix that before testing backup"

backup_name="test-backup-$(date +%s)"
log "triggering on-demand backup: $backup_name"

kubectl apply -f - <<EOF >/dev/null
apiVersion: postgresql.cnpg.io/v1
kind: Backup
metadata:
  name: ${backup_name}
  namespace: ${NAMESPACE}
spec:
  cluster:
    name: ${CLUSTER}
  method: plugin
  pluginConfiguration:
    name: barman-cloud.cloudnative-pg.io
EOF

waited=0
phase=""
while [ "$waited" -lt 180 ]; do
  phase="$(kubectl get backup "$backup_name" -n "$NAMESPACE" -o jsonpath='{.status.phase}' 2>/dev/null || true)"
  case "$phase" in
    completed) break ;;
    failed) fail "backup $backup_name reached phase 'failed' — $(kubectl get backup "$backup_name" -n "$NAMESPACE" -o jsonpath='{.status.error}')" ;;
  esac
  sleep 3; waited=$((waited + 3))
done
[ "$phase" = "completed" ] || fail "backup $backup_name did not complete within 180s (last phase: $phase)"

log "backup $backup_name completed"
pass "backup: on-demand plugin backup reached phase 'completed'"
echo "$backup_name"   # last line: the backup name, for scripts that chain off this (e.g. 05-restore.sh)
