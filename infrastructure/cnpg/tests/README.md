# Postgres test suite (HA / backup / restore)

Repeatable versions of the tests behind
[`docs/postgres-ha-backup-restore.md`](../../../docs/postgres-ha-backup-restore.md).
Each script is standalone, targets a live CNPG `Cluster`, and exits non-zero on
failure so they're CI-able later — right now they're meant to be run by hand against
a real environment before trusting a config change (HA, backup, or plugin version bump)
in that environment.

**They are not run automatically by Flux/CI today.** Running them is a manual gate a
human (or a future pipeline) chooses to run, same as any other pre-promotion check in
this repo.

## Prerequisites

- `kubectl` context pointed at the target cluster
- `NAMESPACE` and `CLUSTER` env vars (defaults: `user-management-app-dev-ns` /
  `user-management-app-db` — the dev environment)
- The target `Cluster` already `Cluster in healthy state` before starting
- For `04-backup.sh` / `05-restore.sh`: the Barman Cloud plugin installed and an
  `ObjectStore` already `Ready` for that cluster (see `../barman-cloud-plugin.yaml` and
  `apps/user-management-app/k8s/base/objectstore.yaml`)

## Run them

```bash
export NAMESPACE=user-management-app-dev-ns
export CLUSTER=user-management-app-db

./01-connectivity.sh     # writes + reads through the -rw service
./02-replication.sh      # confirms every non-primary instance is streaming + in sync
./03-ha-failover.sh      # DESTRUCTIVE: force-kills the current primary, times the failover
./04-backup.sh           # triggers an on-demand plugin backup, waits for completed
./05-restore.sh          # DESTRUCTIVE-ISH: stands up a throwaway restored cluster, verifies data, deletes it

./run-all.sh             # all five, in order, with a pass/fail summary at the end
```

`03` and `05` change real cluster state (a forced pod kill; a temporary extra
`Cluster`). Don't run them against an environment anyone is relying on without knowing
that. `01`, `02`, `04` are safe to run anytime.

## What each one actually checks

| Script | Checks | Destructive? |
|---|---|---|
| `01-connectivity.sh` | `-rw` service accepts a write, `-ro`/`-r` accept a read | no |
| `02-replication.sh` | every replica shows up in `pg_stat_replication` as `streaming`, and has the latest committed row | no |
| `03-ha-failover.sh` | primary survives a forced kill: a new primary is elected, cluster returns to healthy, **no data loss**, writes work again — reports exact timings | **yes** — kills the primary pod |
| `04-backup.sh` | an on-demand `Backup` (`method: plugin`) reaches `phase: completed` | no (creates a `Backup` object + blob data, doesn't touch the live cluster) |
| `05-restore.sh` | a fresh `Cluster` bootstrapped via `recovery` from the latest backup comes up healthy with the expected data present | creates + deletes a temporary `Cluster`; leaves the original untouched |

See `docs/postgres-ha-backup-restore.md` for the two real restore failure modes found
while building `05-restore.sh` (WAL-not-yet-archived, and a backup taken right after a
failover missing its timeline history file) — the script works around both, but if it
starts failing again with a similar error, that doc explains why and how to fix it.
