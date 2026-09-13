#!/usr/bin/env bash
# Shared helpers for the test scripts in this directory. Not run directly.
set -euo pipefail

NAMESPACE="${NAMESPACE:-user-management-app-dev-ns}"
CLUSTER="${CLUSTER:-user-management-app-db}"
DB="${DB:-user-management-app}"
MARKER_TABLE="${MARKER_TABLE:-ha_test_marker}"

log()  { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
fail() { printf '\n[FAIL] %s\n' "$*" >&2; exit 1; }
pass() { printf '\n[PASS] %s\n' "$*"; }

# psql on a given pod, as the postgres superuser
psql_pod() {
  local pod="$1"; shift
  kubectl exec -n "$NAMESPACE" "$pod" -c postgres -- psql -U postgres -d "$DB" -tAc "$*"
}

current_primary() {
  kubectl get cluster "$CLUSTER" -n "$NAMESPACE" -o jsonpath='{.status.currentPrimary}'
}

cluster_phase() {
  kubectl get cluster "$CLUSTER" -n "$NAMESPACE" -o jsonpath='{.status.phase}'
}

ready_instances() {
  kubectl get cluster "$CLUSTER" -n "$NAMESPACE" -o jsonpath='{.status.readyInstances}'
}

wait_for_healthy() {
  local timeout="${1:-180}" waited=0
  while [ "$(cluster_phase)" != "Cluster in healthy state" ]; do
    [ "$waited" -ge "$timeout" ] && fail "cluster did not reach healthy state within ${timeout}s (phase: $(cluster_phase))"
    sleep 3; waited=$((waited + 3))
  done
}

ensure_marker_table() {
  local primary; primary="$(current_primary)"
  psql_pod "$primary" "CREATE TABLE IF NOT EXISTS ${MARKER_TABLE} (id serial primary key, note text, created_at timestamptz default now());" >/dev/null
}
