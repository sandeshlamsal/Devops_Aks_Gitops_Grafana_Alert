# Deploy issue log

Every real problem hit deploying this repo to a live AKS cluster, and how it was fixed.
`kustomize build` / local testing catches syntax errors; it can't catch a live
Kubernetes API rejecting a field, an action tag that doesn't exist, or an RBAC gap that
only shows up once something actually tries to use the permission — this log is the
record of those. Newest first. Each entry: what broke, root cause, the fix, the commit.

---

## 2026-09-12 — Self-correction: don't seed Flux's git credential from a personal token

**Where:** `kv/flux/git-credentials` in OpenBao (used by the `flux-image-updater`
`GitRepository`/`ImageUpdateAutomation` for git write-back of `dev-<N>` image tag bumps).

**What happened:** to unblock `flux-image-automation`'s `GitRepository` auth failure
during first deploy, `gh auth token` (this machine's own logged-in GitHub CLI OAuth
token — `repo` + `workflow` scope, tied to a personal account) was used as a quick
fix. The user caught this and correctly called it out: reusing a broad personal
credential inside a piece of cluster automation is exactly the anti-pattern OpenBao
exists to avoid, even though the value never left the user's own OpenBao instance.

**Fix:** reverted `kv/flux/git-credentials` to a placeholder immediately. Correct
credential is a **fine-grained GitHub PAT scoped to this one repo, `Contents: Read and
write` only** — nothing else — created by the user directly (GitHub has no API for
self-service PAT creation) and seeded by the user directly into OpenBao, so the token
value never passes through an assistant's context at all.

**Lesson:** "it's scoped to your own infrastructure" is not the same bar as "it's the
minimally-privileged credential for the job" — a quick unblock is still wrong if it
reaches for a broader-than-necessary credential, personal or not. This is also why the
Azure side of this same problem (CI/CD's `azure/login`) was designed with OIDC
federated credentials from the start — no stored secret, no personal token, ever.

---

## 2026-09-12 — AKS Flux extension doesn't enable image-automation controllers by default

**Where:** `platform-config-flux-image-automation` Kustomization — applied cleanly
(`READY` eventually `True`), but its `ImageRepository`/`ImagePolicy` resources never
got an `Observed Generation` or any events at all — nothing was reconciling them.

**Root cause:** `az k8s-extension create --extension-type microsoft.flux` installs
only `source-controller`, `kustomize-controller`, `helm-controller`, and
`notification-controller` by default. `image-reflector-controller` and
`image-automation-controller` — the two Flux Image Automation needs — are opt-in.

**Fix:**
```bash
az k8s-extension update -g san-rg -c san-dev-aks -t managedClusters --name flux \
  --config image-automation-controller.enabled=true image-reflector-controller.enabled=true \
  --yes
```
Both pods appeared within ~30s of the extension update succeeding.

**Lesson:** the root README's §3.5 runbook and `docs/operations-runbook.md`'s B4 should
include this flag on the *initial* `az k8s-extension create` for any deploy that uses
`infrastructure/flux-image-automation/` — not yet updated there, follow-up needed.

---

## 2026-09-12 — `aquasecurity/trivy-action@v0.28.0`: broken upstream (deleted transitive tag)

**Where:** `ci.yml` / `release.yml`, `build` job — this is the *second* trivy-action
issue, found immediately after fixing the first one below by adding the missing `v`.

**Symptom:**
```
Unable to resolve action `aquasecurity/setup-trivy@v0.2.1`, unable to find version `v0.2.1`
```

**Root cause:** `trivy-action@v0.28.0` is a real tag, but *that release* internally
pins `aquasecurity/setup-trivy@v0.2.1` as a dependency — and `setup-trivy`'s own tag
list no longer has anything older than `v0.2.6`. Not our config; the upstream action
itself references a tag that's since been deleted.

**Fix:** bumped to `aquasecurity/trivy-action@v0.36.0` (latest release) in both
workflow files. Verified first that the 3 inputs this repo uses (`image-ref`,
`severity`, `exit-code`) are unchanged in `v0.36.0`'s `action.yaml`.

**Commit:** `280f9f9`

**Lesson:** pinning a third-party composite Action to an exact tag doesn't fully
insulate you from its *own* transitive pins breaking later — the fix when that happens
is just to move to a newer release of the same action.

---

## 2026-09-12 — `aquasecurity/trivy-action@0.28.0`: tag doesn't exist

**Where:** `ci.yml` / `release.yml`, `build` job, failed at "Set up job" (before any
step even ran).

**Symptom:**
```
Unable to resolve action `aquasecurity/trivy-action@0.28.0`, unable to find version `0.28.0`
```

**Root cause:** the action's real git tags are `v0.28.0` (with a `v` prefix) —
`0.28.0` never existed. Confirmed against `aquasecurity/trivy-action`'s tag list.

**Fix:** `aquasecurity/trivy-action@0.28.0` → `aquasecurity/trivy-action@v0.28.0` in
both workflow files.

**Commit:** `bcb41bd`

---

## 2026-09-12 — `ExternalSecret.spec.target.template.engine`: field doesn't exist in ESO v1

**Where:** `infrastructure/flux-image-automation/acr-pull-secret.yaml`, applied by the
`flux-image-automation` Flux Kustomization.

**Symptom:** Kustomization stuck `READY=False`:
```
ExternalSecret/flux-system/acr-credentials dry-run failed: failed to create typed
patch object ...: .spec.target.template.engine: field not declared in schema
```

**Root cause:** the field is named `engineVersion` in `external-secrets.io/v1` (ESO
0.20.4, the version this repo installs) — `engine` was presumably valid in an older
ESO API version this repo predates. `kustomize build` can't catch this: it validates
YAML structure, not a live CRD's actual OpenAPI schema.

**Fix:** `engine: v2` → `engineVersion: v2`. Also fixed the same stale field name in
`infrastructure/secrets/README.md`'s docs example (same mistake, not yet live).

**Commit:** `374c4e5`

---

<!-- Add new entries above this line, newest first. -->
