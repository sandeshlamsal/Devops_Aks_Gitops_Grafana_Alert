# Postgres HA, backup & restore — tested in dev, proposed for team approval

Everything in this doc was tested live against a real CloudNativePG cluster, deployed
the same way the team would deploy it — **through Flux/GitOps**, not `kubectl apply` by
hand — on a throwaway dev AKS cluster. Nothing here is theoretical — every number,
every failure mode, and every fix below was observed, not looked up. The environment
has since been torn down; this doc plus the proposed config diff (§6) and the
[automated test suite](../infrastructure/cnpg/tests/) are what's left to review.

**Ask: review §5 (recommendation) and §6 (config diff), approve or push back.**

**Revision note:** an earlier version of this doc tested the *native*
`spec.backup.barmanObjectStore` config. That path is deprecated upstream and is dropped
entirely in CloudNativePG 1.31. This revision migrates to the **Barman Cloud CNPG-I
plugin** instead (§3), deploys everything through Flux (§2), and adds a runnable,
repeatable [test suite](../infrastructure/cnpg/tests/) so this doesn't have to be
re-verified by hand next time.

---

## 1. What's true today (before this change)

- `db-cluster.yaml` sets `spec.instances: 1` — **no HA**. If the single pod or its node
  dies, the app has no database until CNPG reschedules and replays WAL from the PVC.
  No replica to fail over to.
- No `spec.backup` / `spec.plugins` block at all — **no backup**. If the PVC is lost
  (node failure, storage fault, `kubectl delete pvc`, a bad `az aks stop`/teardown), the
  data is gone. Nothing to restore from.

This is fine for a disposable dev/demo database. It is not something to carry into an
environment anyone depends on.

---

## 2. Deployed through Flux — what that took

The point of this pass wasn't just "does HA/backup/restore work" — it was "does it work
the way we'd actually run it," i.e. GitOps end to end: commit manifests, Flux applies
them, nothing hand-run against the live cluster except the test suite itself. Getting
there surfaced three real, worth-documenting issues, none of which are CNPG's fault:

**flux-applier needs explicit RBAC per namespace, every time.** The AKS Flux extension
only auto-provisions its `flux-applier` ServiceAccount in `flux-system`. Every other
namespace a Kustomization targets (`cert-manager`, `cnpg-system`, and whatever
namespace the app's `Cluster` lands in) needs `flux-applier` bootstrapped by hand:
a namespaced `RoleBinding` to `admin` (full control *within that one namespace*) plus a
narrow custom `ClusterRole` — **not `cluster-admin`** — for the handful of cluster-scoped
things Helm charts install (CRDs, their own ClusterRoles/ClusterRoleBindings, admission
webhooks). This is already documented in the root README §3.6 and
`infrastructure/cnpg/tests/README.md`; repeating it here because skipping it is the
single most common way this GitOps path breaks with an opaque `secrets is forbidden`
error that has nothing to do with Postgres.

**cert-manager (a hard prerequisite for the Barman plugin, see §3) defaults its leader
election to `kube-system`.** Every `flux-applier` in this repo is scoped to one
namespace only, so the chart's default install fails trying to read a `Role` in
`kube-system`. Fix: pin `global.leaderElection.namespace` to `cert-manager` itself —
the [officially acknowledged fix upstream](https://github.com/cert-manager/cert-manager/issues/8476)
for exactly this. (First attempt put `leaderElection` at the values root — the chart's
`values.schema.json` rejects that with `additional properties 'leaderElection' not
allowed`; it has to be nested under `global`.) Already fixed in
`infrastructure/cert-manager/cert-manager.yaml`.

**A Flux `Kustomization` mid-health-check won't drop everything for a new commit.**
While cert-manager's HelmRelease was failing (the issue above), the owning
`Kustomization` sat in "running health checks... timeout 10m0s" — annotating it for an
immediate reconcile did *not* interrupt that wait, so the fix sat unapplied for the
full 10 minutes until the check timed out on its own. Deleting the `Kustomization`
object to force a clean restart is tempting but has a sharp edge: **the delete is
asynchronous** (finalizer-driven prune), and if you move on and re-apply things by hand
before it's actually finished, the prune step will delete whatever you just fixed out
from under you the moment it does complete — happened once during this test. Lesson: after
deleting a stuck `Kustomization`, wait for confirmation it's actually gone (or genuinely
recreated) before touching anything it owns again.

Once past those three, the rest reconciled cleanly: cert-manager → the CNPG operator
**adopting the pre-existing `cloudnative-pg` Helm release** (upgrade, not a fresh
install — Flux's helm-controller uses the same release storage as any other Helm
client, so this just works) → the Barman Cloud plugin → the `Cluster` + `ObjectStore` +
`ScheduledBackup`, in that dependency order, via three Flux `Kustomization`s
(`cert-manager`, `cnpg-operator`, and a test-only `postgres-tests` fixture — see
`infrastructure/cnpg/tests/fixture-cluster/`).

---

## 3. Backup & restore via the Barman Cloud plugin — tested

### What changed

The deprecated native path (`spec.backup.barmanObjectStore` directly on the `Cluster`)
is replaced by the **Barman Cloud CNPG-I plugin**
([cloudnative-pg/plugin-barman-cloud](https://github.com/cloudnative-pg/plugin-barman-cloud)),
installed as its own operator (`infrastructure/cnpg/barman-cloud-plugin.yaml`, same
namespace as CNPG itself — a hard requirement of the plugin, not a choice), talking to
CNPG over a cert-manager-secured CNPG-I gRPC endpoint (hence §2's cert-manager
prerequisite). The backup destination becomes its own CRD, decoupled from the `Cluster`:

```yaml
# apps/user-management-app/k8s/base/objectstore.yaml
apiVersion: barmancloud.cnpg.io/v1
kind: ObjectStore
metadata:
  name: user-management-app-db-store
spec:
  retentionPolicy: "7d"
  configuration:
    destinationPath: "https://<STORAGE_ACCOUNT>.blob.core.windows.net/<container>"
    azureCredentials:
      storageAccount: { name: azure-storage-creds, key: AZURE_STORAGE_ACCOUNT }
      storageKey:     { name: azure-storage-creds, key: AZURE_STORAGE_KEY }
```

```yaml
# apps/user-management-app/k8s/base/db-cluster.yaml — the Cluster opts in
spec:
  instances: 3
  plugins:
    - name: barman-cloud.cloudnative-pg.io
      isWALArchiver: true
      parameters:
        barmanObjectName: user-management-app-db-store
```

The `azure-storage-creds` Secret is **not in git** — same rule as every other secret in
this repo (see `infrastructure/secrets/README.md`). Create it once per environment:

```bash
kubectl create secret generic azure-storage-creds -n <namespace> \
  --from-literal=AZURE_STORAGE_ACCOUNT=<storage account name> \
  --from-literal=AZURE_STORAGE_KEY=<storage account key>
```

### This is materially better than the native path, not just "less deprecated"

The two real restore failures documented in the previous revision of this doc — a
backup unrestorable because its WAL segment hadn't rolled over yet, and a backup taken
right after a failover missing its timeline history file — were both caused by
**archiving being too lazy** under the native config. Under the plugin, WAL archiving
was visibly more eager in every run of the test suite: new segments landed in blob
storage roughly every time one filled, and — the specific case that broke the native
path — **the post-failover `00000002.history` file archived successfully on its own**,
observed directly in blob storage (`user-management-app-db/wals/00000002.history`,
timestamped seconds after the failover's promotion). The restore test suite (`05-restore.sh`)
still defensively checks `pg_stat_archiver` and forces a `pg_switch_wal()` before
trusting a backup — cheap insurance — but did not need to work around either original
failure mode this time.

### Test results (from the automated suite — see §4 for the full run)

| Test | Result |
|---|---|
| On-demand backup (`04-backup.sh`) | **completed in 7s** (native path: 13s) |
| Backup contents in blob storage | confirmed: `base/<ts>/{backup.info,data.tar}` + continuous `wals/` segments |
| WAL archiving after a forced failover | `00000002.history` archived automatically — no manual intervention, unlike the native path |
| Restore into a fresh cluster (`05-restore.sh`) | healthy in **75s** (native path: 103s), all rows intact |

### Restore — still base-backup-granularity only

Same caveat as before: `bootstrap.recovery` restores to the backup's own consistent
point, not an arbitrary moment. True PITR needs a `recoveryTarget`
(time/LSN/transaction) at restore time on top of this — not exercised here.

```yaml
# restore syntax — note this differs from the deprecated native externalClusters shape
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata: { name: <name>-restored, namespace: <ns> }
spec:
  instances: 1
  storage: { size: 1Gi }
  bootstrap:
    recovery: { source: origin }
  externalClusters:
    - name: origin
      plugin:
        name: barman-cloud.cloudnative-pg.io
        parameters:
          barmanObjectName: user-management-app-db-store
          serverName: user-management-app-db
```

---

## 4. HA — tested (unchanged mechanism, re-confirmed via the automated suite)

`spec.instances: 1` → `3` → 1 primary + 2 streaming replicas, automatic failover.
Mechanism is identical to before (Postgres/CNPG's HA doesn't change based on backup
method); numbers below are from `03-ha-failover.sh`'s run against the
plugin-backed, Flux-deployed cluster in §2-3, for an apples-to-apples comparison:

| Event | Result |
|---|---|
| Force-killed the primary pod (`--grace-period=0 --force`) | — |
| New primary elected | **22.4s** |
| Cluster fully healthy again (old primary rejoined as a replica) | **50.1s** |
| Data loss | **none** — all 3 rows preserved across the failover |
| Writes resume | confirmed via a fresh `INSERT` against the new primary — succeeded |

(Slightly slower than the first run's 16–18s/40s — both are real single-sample
measurements on a shared dev node pool, not a guaranteed SLA either way. Order of
magnitude — low tens of seconds — is the number to plan around, not the exact digit.)

### What this costs

Each instance is a full Postgres pod + its own PVC. Going 1→3 instances **triples**
compute + storage for this database. On AKS that's 3 pods, 3 PVCs (3 managed disks),
spread across nodes by CNPG's own anti-affinity — no extra Azure resources beyond more
of what's already there.

---

## 5. The automated test suite

Everything above is also a runnable, repeatable test suite now:
[`infrastructure/cnpg/tests/`](../infrastructure/cnpg/tests/). Five scripts —
connectivity, replication, forced-failover HA, on-demand backup, restore-into-a-fresh-cluster
— plus a `run-all.sh` that runs all five and prints a pass/fail summary. Full details,
prerequisites, and which ones are destructive: see that directory's own README.

**Latest full run (against the Flux-deployed cluster in §2):**

```
==================== summary ====================
PASS  01-connectivity.sh
PASS  02-replication.sh
PASS  03-ha-failover.sh
PASS  04-backup.sh
PASS  05-restore.sh
```

This is meant to be re-run — before trusting a CNPG version bump, a Barman plugin
version bump, or a `Cluster`/`ObjectStore` config change in any real environment, not
just once here in a throwaway dev cluster.

---

## 6. Recommendation

- **HA: recommend adopting.** Clean, fast, automatic, zero data loss across two
  independent test runs, and the cost is just more of the same compute/storage already
  in use — no new Azure resources.
- **Backup/restore via the Barman Cloud plugin: recommend adopting** — it's not just
  "less deprecated" than the native path, it measurably avoided both real failure modes
  the native path hit, and cert-manager is a reasonable one-time infra cost (widely used
  already; not exotic).
- **Restore is still base-backup-granularity only** — fine for disaster recovery, not
  for "restore to right before that bad migration ran 10 minutes ago" without adding a
  `recoveryTarget`-based PITR test on top.
- **GitOps rollout is real, not aspirational** — everything in §2-3 was deployed via
  Flux `Kustomization`s pointing at a git branch, the same mechanism this repo already
  uses for every other operator. The three gotchas in §2 are now documented so the next
  environment doesn't have to rediscover them.

---

## 7. Proposed config diff

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
+  plugins:
+    - name: barman-cloud.cloudnative-pg.io
+      isWALArchiver: true
+      parameters:
+        barmanObjectName: user-management-app-db-store
```

Plus, per environment: `infrastructure/cert-manager/` and the Barman Cloud plugin
(`infrastructure/cnpg/barman-cloud-plugin.yaml`) as one-time cluster-wide infra: an
Azure Storage Account + container for backups; the `azure-storage-creds` Secret (manual,
not in git); and the `ObjectStore` + `ScheduledBackup` CRs
(`apps/user-management-app/k8s/base/objectstore.yaml`, already wired into the
dev/qa/prod overlays with per-environment container paths).

**Open questions for the team:**
- Same storage account for all three envs (cheaper, simpler) or one per environment
  (better isolation, no cross-env blast radius on a credential leak)? Overlays are
  already structured to support either.
- `retentionPolicy: "7d"` — is a week enough, given restore is base-backup-granularity
  only (no PITR)?
- Worth a follow-up test adding a `recoveryTarget` for true point-in-time recovery, or
  is "restore to last backup" sufficient for this app's RPO needs?
- `azure-storage-creds` is a plain Kubernetes Secret today, created manually outside
  git — consistent with this repo's existing secrets philosophy, but not flowing through
  OpenBao/External Secrets like everything else. Worth wiring up, or is "one more manual
  bootstrap step, documented" fine here too?
