#!/usr/bin/env bash
# Test case: forced primary failure → automatic promotion, no data loss.
# DESTRUCTIVE: force-kills the current primary pod. Only run against an environment
# you're allowed to disrupt.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./00-common.sh

instances="$(kubectl get cluster "$CLUSTER" -n "$NAMESPACE" -o jsonpath='{.spec.instances}')"
[ "$instances" -ge 2 ] || fail "spec.instances=$instances — no replica to fail over to, this test needs instances >= 2"

[ "$(cluster_phase)" = "Cluster in healthy state" ] || fail "cluster is not healthy before starting (phase: $(cluster_phase))"

old_primary="$(current_primary)"
log "current primary: $old_primary"

ensure_marker_table
pre_note="pre-failover-$(date +%s)"
psql_pod "$old_primary" "INSERT INTO ${MARKER_TABLE} (note) VALUES ('${pre_note}');" >/dev/null
before_count="$(psql_pod "$old_primary" "SELECT count(*) FROM ${MARKER_TABLE};")"
log "wrote marker '$pre_note' — $before_count total rows before failover"

kill_time=$(date -u +%s.%N)
log "force-deleting primary pod $old_primary ..."
kubectl delete pod "$old_primary" -n "$NAMESPACE" --grace-period=0 --force >/dev/null 2>&1

new_primary=""
promotion_time=""
waited=0
while [ "$waited" -lt 120 ]; do
  p="$(current_primary || true)"
  if [ -n "$p" ] && [ "$p" != "$old_primary" ]; then
    new_primary="$p"
    promotion_time=$(date -u +%s.%N)
    break
  fi
  sleep 2; waited=$((waited + 2))
done
[ -n "$new_primary" ] || fail "no new primary elected within 120s of killing $old_primary"

promotion_seconds=$(awk "BEGIN {printf \"%.1f\", $promotion_time - $kill_time}")
log "new primary: $new_primary (promotion decision after ${promotion_seconds}s)"

wait_for_healthy 180
healthy_time=$(date -u +%s.%N)
healthy_seconds=$(awk "BEGIN {printf \"%.1f\", $healthy_time - $kill_time}")
log "cluster fully healthy again after ${healthy_seconds}s total"

after_count="$(psql_pod "$new_primary" "SELECT count(*) FROM ${MARKER_TABLE};")"
[ "$after_count" = "$before_count" ] || fail "row count changed across failover: before=$before_count after=$after_count — DATA LOSS"

post_note="post-failover-$(date +%s)"
psql_pod "$new_primary" "INSERT INTO ${MARKER_TABLE} (note) VALUES ('${post_note}');" >/dev/null || fail "could not write through the new primary after failover"

pass "HA failover: promotion in ${promotion_seconds}s, fully healthy in ${healthy_seconds}s, zero data loss ($before_count rows preserved), writes resumed"
