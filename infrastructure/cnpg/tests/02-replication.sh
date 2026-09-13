#!/usr/bin/env bash
# Test case: every non-primary instance is streaming and caught up.
# Not destructive.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./00-common.sh

instances="$(kubectl get cluster "$CLUSTER" -n "$NAMESPACE" -o jsonpath='{.spec.instances}')"
log "cluster=$CLUSTER namespace=$NAMESPACE spec.instances=$instances"

if [ "$instances" -lt 2 ]; then
  log "spec.instances=$instances — nothing to replicate to, skipping (this is not a failure, just not applicable)"
  exit 0
fi

primary="$(current_primary)"
log "current primary: $primary"

replica_count="$(psql_pod "$primary" "SELECT count(*) FROM pg_stat_replication;")"
expected=$((instances - 1))
[ "$replica_count" = "$expected" ] || fail "expected $expected replicas streaming, pg_stat_replication shows $replica_count"

not_streaming="$(psql_pod "$primary" "SELECT count(*) FROM pg_stat_replication WHERE state != 'streaming';")"
[ "$not_streaming" = "0" ] || fail "$not_streaming replica(s) are connected but not in 'streaming' state"

ensure_marker_table
note="replication-check-$(date +%s)"
psql_pod "$primary" "INSERT INTO ${MARKER_TABLE} (note) VALUES ('${note}');" >/dev/null

# give async replication a moment, then confirm on every replica pod
sleep 3
for pod in $(kubectl get pods -n "$NAMESPACE" -l "cnpg.io/cluster=${CLUSTER},cnpg.io/instanceRole=replica" -o jsonpath='{.items[*].metadata.name}'); do
  found="$(psql_pod "$pod" "SELECT count(*) FROM ${MARKER_TABLE} WHERE note = '${note}';")"
  [ "$found" = "1" ] || fail "replica $pod does not have the marker row written on the primary — replication lag or break"
  log "replica $pod: marker present, in sync"
done

pass "replication: $expected/$expected replicas streaming and caught up"
