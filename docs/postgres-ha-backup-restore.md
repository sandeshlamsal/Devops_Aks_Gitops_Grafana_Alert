# Postgres HA, backup & restore — tested in dev, proposed for team approval

Everything in this doc was tested live against a real CloudNativePG cluster running the
repo's own `apps/user-management-app/k8s/base/db-cluster.yaml`, on a throwaway dev AKS
cluster. Nothing here is theoretical — every number and every failure mode below was
observed, not looked up. The environment has since been torn down; this doc plus the
proposed config diff (§5) is what's left to review.

**Ask: review §4 (recommendation) and §5 (config diff), approve or push back.**

---

## 1. What's true today (before this change)

- `db-cluster.yaml` sets `spec.instances: 1` — **no HA**. If the single pod or its node
  dies, the app has no database until CNPG reschedules and replays WAL from the PVC.
  No replica to fail over to.
- No `spec.backup` block at all — **no backup**. If the PVC is lost (node failure,
  storage fault, `kubectl delete pvc`, a bad `az aks stop`/teardown), the data is gone.
  Nothing to restore from.

This is fine for a disposable dev/demo database. It is not something to carry into an
environment anyone depends on.

---

## 2. HA — tested

### What changed
`spec.instances: 1` → `spec.instances: 3`. CNPG turns this into 1 primary + 2 streaming
replicas, each on (ideally) a different node, with automatic failover.

### Test performed
1. Started at 1 instance, inserted a marker row.
2. Scaled to 3 instances live (`kubectl patch cluster ... instances: 3`) — no downtime,
   no manual steps. CNPG provisioned both replicas itself (~90s total: each new replica
   runs a `pg_basebackup`-style join, then starts streaming).
3. Confirmed streaming replication (`pg_stat_replication`: both replicas `streaming` /
   `async`) and that the marker row was present on both replicas.
4. Inserted a second marker, then **force-killed the primary pod**
   (`kubectl delete pod ... --grace-period=0 --force`) to simulate a hard node/pod
   failure — no graceful shutdown, no warning to CNPG.

### Results (real timestamps)

| Event | Time | Elapsed since kill |
|---|---|---|
| Primary force-deleted | 13:53:34.494 | — |
| CNPG's promotion decision (a replica becomes the new primary) | ~13:53:50–52 | **~16–18s** |
| Cluster fully healthy again, 3/3 instances (old primary rejoined automatically as a new replica) | 13:54:14.784 | **~40s** |
| Data loss | **none** — both markers present after failover | — |
| Writes resume | confirmed via a fresh `INSERT` against the `-rw` service immediately after promotion — succeeded | — |

Nobody had to intervene. The old primary pod came back on its own as a replica; CNPG
re-clones and re-joins it automatically once it's schedulable again.

### What this costs
Each instance is a full Postgres pod + its own PVC. Going 1→3 instances **triples**
compute + storage for this database (current `db-cluster.yaml` requests:
100m/256Mi–500m/512Mi CPU/mem per instance, `storage.size: 1Gi` per instance). On AKS
that's 3 pods, 3 PVCs (3 managed disks), spread across nodes by CNPG's own anti-affinity
— no extra Azure resources to provision, just more of what's already there.

### RTO characteristic to note
~40s includes the *old* primary fully rejoining as a healthy replica — the app was only
actually unable to write for the ~16–18s until a new primary was chosen. Client-side
retry/reconnect logic matters here: a client that gives up after one failed write
instead of retrying briefly will see a real (short) outage.

---

## 3. Backup & restore — tested

### What changed
Added `spec.backup.barmanObjectStore`, pointing at a dedicated Azure Blob Storage
container, authenticated via a Kubernetes Secret holding the storage account name + key.
This does two things: periodic base backups, and **continuous WAL archiving** to the
same destination (the latter matters — see §3.3).

```yaml
backup:
  barmanObjectStore:
    destinationPath: "https://<STORAGE_ACCOUNT>.blob.core.windows.net/postgres-backups"
    azureCredentials:
      storageAccount: { name: azure-storage-creds, key: AZURE_STORAGE_ACCOUNT }
      storageKey:     { name: azure-storage-creds, key: AZURE_STORAGE_KEY }
  retentionPolicy: "7d"
```

> **Deprecation notice (not a blocker, but real):** applying this prints
> `Native support for Barman Cloud backups and recovery is deprecated and will be
> completely removed in CloudNativePG 1.31.0 ... migrate to the Barman Cloud Plugin`.
> It still works today (tested below) but CNPG intends to remove it. Migrating to the
> plugin is a separate, later piece of work — flagging it now so it's a known follow-up,
> not a surprise.

### 3.1 On-demand backup — tested, works

```bash
kubectl apply -f - <<'EOF'
apiVersion: postgresql.cnpg.io/v1
kind: Backup
metadata: { name: test-backup, namespace: <ns> }
spec: { cluster: { name: user-management-app-db } }
EOF
```

Completed in **13 seconds**. Confirmed present in blob storage:
`user-management-app-db/base/<timestamp>/{backup.info,data.tar}` (~33MB for this
near-empty test DB).

### 3.2 Scheduled backup — configured, not fully run to completion

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: ScheduledBackup
metadata: { name: daily-backup, namespace: <ns> }
spec:
  schedule: "0 0 2 * * *"          # 2am daily
  backupOwnerReference: self
  cluster: { name: user-management-app-db }
```

Applied and accepted by the operator; didn't wait out a full day in a throwaway
environment to watch it fire on schedule. Mechanically identical to the on-demand
backup above, which did complete and verify.

### 3.3 Restore — tested, and this is the part worth reading carefully

Two real failures happened during this test, both worth understanding before anyone
relies on this in practice — neither is a CNPG bug, both are "backup-only object store
restore has sharp edges" gotchas.

**Failure 1 — restore needs WAL, not just the base backup.**
First restore attempt failed immediately:
```
WAL file 000000020000000000000007 does not exist ... WAL not found
```
A CNPG object-store backup is a **filesystem snapshot**, not internally consistent on
its own — Postgres needs to replay WAL up to the backup's own end-of-backup LSN before
it can start. On a quiet test database, the WAL segment covering that LSN hadn't rolled
over naturally and so had never been archived yet.
**Fix:** `SELECT pg_switch_wal();` right after taking a backup (or rely on
`archive_timeout`, which defaults to disabled) forces that segment out immediately.
**Takeaway for real usage:** on a low-write database, a fresh backup can be
*unrestorable* for a while after being taken, until enough WAL activity — natural or
forced — pushes the needed segment to the archive. Don't assume "backup completed" means
"restorable right now."

**Failure 2 — a backup taken shortly after a failover can be unrestorable.**
Second restore attempt (from a backup taken ~2 minutes after the HA failover test in
§2) failed differently:
```
unexpected timeline ID 1 in WAL segment ... invalid checkpoint record
could not locate required checkpoint record
```
Root cause, confirmed directly: failover moves the cluster to a new Postgres **timeline**
(1→2), which requires a `00000002.history` file to be archived so restores can resolve
which timeline is which. That specific archive attempt failed at the exact moment of
the forced pod deletion (the old primary's archiver got killed mid-attempt) and —
notably — **never retried**: Postgres's local `archive_status/*.done` marker said it
succeeded, but the file was never actually present in blob storage. `pg_stat_archiver`
still correctly showed it in `last_failed_wal`, which is how this was caught.
**Fix applied:** took a fresh backup well after the failover (same, now-stable timeline)
— restored cleanly.
**Takeaway for real usage:** a backup taken in the immediate aftermath of a failover is
not automatically safe to restore from. Before trusting a backup, check
`pg_stat_archiver` (especially `failed_count` / `last_failed_wal`) on the current
primary, not just "the Backup CR says completed."

### Successful restore — confirmed data integrity

Restored into a brand-new `Cluster` (`bootstrap.recovery`, pointing the same
`barmanObjectStore` destination as an `externalClusters` source):

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata: { name: <name>-restored, namespace: <ns> }
spec:
  instances: 1
  storage: { size: 1Gi }
  bootstrap:
    recovery: { source: original-backup }
  externalClusters:
    - name: original-backup
      barmanObjectStore:
        destinationPath: "https://<STORAGE_ACCOUNT>.blob.core.windows.net/postgres-backups"
        azureCredentials: { ... same as above ... }
        serverName: user-management-app-db
```

Reached `Cluster in healthy state` in ~103 seconds. Verified every row present and
correct, including one inserted *after* the backup completed (this backup had no
canary-after-backup gap, since it was taken after that insert — see the marker table
below for what a restore actually captures):

| id | note | present in restore? |
|---|---|---|
| 1 | pre-scale-to-3 | yes |
| 2 | pre-failover | yes |
| 35 | post-failover-verify | yes |
| 36 | inserted before this specific backup was taken | yes |

This confirms: restore recovers to the backup's own consistent point — not a point in
time chosen at restore time. **There is no PITR (point-in-time recovery) to an arbitrary
moment with this config** — only "restore to when the backup was taken." True PITR needs
continuous WAL archiving *plus* a `recoveryTarget` (time/LSN/transaction) at restore
time, which wasn't exercised here and is a reasonable next test if the team wants finer
recovery granularity than "last backup."

---

## 4. Recommendation

- **HA (§2): recommend adopting.** Clean, fast, automatic, zero data loss in testing,
  and the cost is just more of the same compute/storage already in use — no new Azure
  resources. The only real cost is 3x the pods/storage for this one database.
- **Backup (§3): recommend adopting, with two operational rules attached**, both learned
  the hard way above:
  1. After configuring backup, don't assume it's restorable until WAL has actually
     rolled over (or force it with `pg_switch_wal()` after each manual backup).
  2. Don't trust a backup taken immediately after a failover without checking
     `pg_stat_archiver` first.
- **Restore: works, but is base-backup-granularity only** — recovery point is "when the
  backup ran," not a chosen moment. Fine for disaster recovery ("we lost the PVC");
  not fine for "restore to right before that bad migration ran 10 minutes ago" without
  further PITR work.
- **Known follow-up, not a blocker:** `barmanObjectStore` is deprecated in favor of the
  Barman Cloud Plugin — this config will need to move at some point before CNPG 1.31.

---

## 5. Proposed config diff

```diff
 apiVersion: postgresql.cnpg.io/v1
 kind: Cluster
 metadata:
   name: user-management-app-db
 spec:
-  instances: 1
+  instances: 3
   storage:
     size: 1Gi
   bootstrap:
     initdb:
       database: user-management-app
       owner: appuser
   resources:
     requests:
       cpu: 100m
       memory: 256Mi
     limits:
       cpu: 500m
       memory: 512Mi
+  backup:
+    barmanObjectStore:
+      destinationPath: "https://<STORAGE_ACCOUNT>.blob.core.windows.net/postgres-backups"
+      azureCredentials:
+        storageAccount: { name: azure-storage-creds, key: AZURE_STORAGE_ACCOUNT }
+        storageKey:     { name: azure-storage-creds, key: AZURE_STORAGE_KEY }
+    retentionPolicy: "7d"
```

Plus, per environment: an Azure Storage Account + blob container for backups, and a
`ScheduledBackup` CR (§3.2). Applying this per-environment (dev/qa/prod) rather than
globally lets the team roll it out incrementally — dev first, to build confidence in the
two operational rules from §3.3, before qa/prod.

**Open questions for the team:**
- Same storage account for all three envs (cheaper, simpler) or one per environment
  (better isolation, no cross-env blast radius on a credential leak)?
- `retentionPolicy: "7d"` — is a week enough, given restore is base-backup-granularity
  only (no PITR)?
- Worth the follow-up work to migrate to the Barman Cloud Plugin now, or ride the
  deprecated path until CNPG actually forces the issue?
