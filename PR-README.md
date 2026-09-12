# Deploy issue log

Every real problem hit deploying this repo to a live AKS cluster, and how it was fixed.
`kustomize build` / local testing catches syntax errors; it can't catch a live
Kubernetes API rejecting a field, an action tag that doesn't exist, or an RBAC gap that
only shows up once something actually tries to use the permission — this log is the
record of those. Newest first. Each entry: what broke, root cause, the fix, the commit.

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
