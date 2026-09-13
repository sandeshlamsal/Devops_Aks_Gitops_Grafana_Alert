#!/usr/bin/env bash
# Test case: restore into a brand-new cluster from the latest backup, verify data
# integrity, then clean up. Leaves the original cluster untouched — but before trusting
# a backup, this script also checks pg_stat_archiver for a recent archive failure (the
# real gotcha documented in docs/postgres-ha-backup-restore.md: a backup taken right
# after a failover can look "completed" while missing its timeline history file).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./00-common.sh

OBJECTSTORE_NAME="${OBJECTSTORE_NAME:-${CLUSTER}-store}"
RESTORE_NAME="${CLUSTER}-restore-test-$(date +%s)"

[ "$(cluster_phase)" = "Cluster in healthy state" ] || fail "cluster is not healthy (phase: $(cluster_phase)) — fix that before testing restore"

primary="$(current_primary)"

# Sanity check from docs/postgres-ha-backup-restore.md §3.3: don't trust a backup taken
# while the archiver has a recent unresolved failure.
failed_count="$(psql_pod "$primary" "SELECT failed_count FROM pg_stat_archiver;" 2>/dev/null || echo 0)"
last_failed="$(psql_pod "$primary" "SELECT last_failed_wal FROM pg_stat_archiver;" 2>/dev/null || echo '')"
if [ "${failed_count:-0}" != "0" ] && [ -n "$last_failed" ]; then
  log "WARNING: pg_stat_archiver shows a past archive failure (last_failed_wal=$last_failed, failed_count=$failed_count)."
  log "This does not necessarily mean the current backup is broken, but is exactly the"
  log "symptom that caused a real restore failure during testing — see docs/postgres-ha-backup-restore.md §3.3."
  log "Forcing a WAL switch now to make sure the archiver is current before proceeding."
  psql_pod "$primary" "SELECT pg_switch_wal();" >/dev/null
  sleep 5
fi

log "triggering a fresh backup to restore from"
./04-backup.sh
sleep 5
# ensure the WAL segment the backup needs is actually archived — the other real gotcha
# from docs/postgres-ha-backup-restore.md §3.3 (a quiet DB may not roll WAL naturally)
psql_pod "$primary" "SELECT pg_switch_wal();" >/dev/null
sleep 5

log "bootstrapping restore cluster: $RESTORE_NAME (from ObjectStore $OBJECTSTORE_NAME, server $CLUSTER)"
kubectl apply -f - <<EOF >/dev/null
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: ${RESTORE_NAME}
  namespace: ${NAMESPACE}
spec:
  instances: 1
  storage:
    size: 1Gi
  bootstrap:
    recovery:
      source: origin
  externalClusters:
    - name: origin
      plugin:
        name: barman-cloud.cloudnative-pg.io
        parameters:
          barmanObjectName: ${OBJECTSTORE_NAME}
          serverName: ${CLUSTER}
EOF

cleanup() {
  log "cleaning up restore test cluster $RESTORE_NAME"
  kubectl delete cluster "$RESTORE_NAME" -n "$NAMESPACE" --wait=false >/dev/null 2>&1 || true
}
trap cleanup EXIT

waited=0
while [ "$waited" -lt 300 ]; do
  phase="$(kubectl get cluster "$RESTORE_NAME" -n "$NAMESPACE" -o jsonpath='{.status.phase}' 2>/dev/null || true)"
  [ "$phase" = "Cluster in healthy state" ] && break
  # fail fast on a stuck/errored recovery job instead of waiting out the full timeout
  if kubectl get pods -n "$NAMESPACE" -l "cnpg.io/cluster=${RESTORE_NAME}" -o jsonpath='{.items[*].status.containerStatuses[*].state.terminated.reason}' 2>/dev/null | grep -q Error; then
    fail "restore cluster $RESTORE_NAME's recovery job errored — see: kubectl logs -n $NAMESPACE -l cnpg.io/cluster=${RESTORE_NAME}"
  fi
  sleep 5; waited=$((waited + 5))
done
[ "$phase" = "Cluster in healthy state" ] || fail "restore cluster did not become healthy within 300s (last phase: $phase)"
log "restore cluster healthy after ${waited}s"

restore_pod="${RESTORE_NAME}-1"
expected_count="$(psql_pod "$primary" "SELECT count(*) FROM ${MARKER_TABLE};")"
restored_count="$(kubectl exec -n "$NAMESPACE" "$restore_pod" -c postgres -- psql -U postgres -d "$DB" -tAc "SELECT count(*) FROM ${MARKER_TABLE};")"
[ "$restored_count" = "$expected_count" ] || fail "row count mismatch: source had $expected_count, restore has $restored_count"

pass "restore: fresh cluster from latest backup came up healthy with all $restored_count rows intact"
