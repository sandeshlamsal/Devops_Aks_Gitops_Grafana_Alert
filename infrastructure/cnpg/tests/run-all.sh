#!/usr/bin/env bash
# Runs every test case in order, prints a pass/fail summary. Non-zero exit if any fail.
# See README.md in this directory for what each one does and which are destructive.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

export NAMESPACE="${NAMESPACE:-user-management-app-dev-ns}"
export CLUSTER="${CLUSTER:-user-management-app-db}"

tests=(01-connectivity.sh 02-replication.sh 03-ha-failover.sh 04-backup.sh 05-restore.sh)
results=()
overall=0

for t in "${tests[@]}"; do
  echo
  echo "==================== $t ===================="
  if ./"$t"; then
    results+=("PASS  $t")
  else
    results+=("FAIL  $t")
    overall=1
  fi
done

echo
echo "==================== summary ===================="
printf '%s\n' "${results[@]}"
exit $overall
