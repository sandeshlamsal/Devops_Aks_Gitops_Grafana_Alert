#!/usr/bin/env bash
# Test case: basic read/write connectivity through CNPG's rw/ro/r services.
# Not destructive.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./00-common.sh

log "cluster=$CLUSTER namespace=$NAMESPACE"

[ "$(cluster_phase)" = "Cluster in healthy state" ] || fail "cluster is not healthy (phase: $(cluster_phase)) — fix that before testing connectivity"

primary="$(current_primary)"
log "current primary: $primary"

ensure_marker_table
note="connectivity-check-$(date +%s)"
psql_pod "$primary" "INSERT INTO ${MARKER_TABLE} (note) VALUES ('${note}');" >/dev/null
log "wrote marker '$note' via primary pod"

found="$(psql_pod "$primary" "SELECT count(*) FROM ${MARKER_TABLE} WHERE note = '${note}';")"
[ "$found" = "1" ] || fail "wrote a row but couldn't read it back on the primary"

pass "connectivity: write + read-back through the primary succeeded"
