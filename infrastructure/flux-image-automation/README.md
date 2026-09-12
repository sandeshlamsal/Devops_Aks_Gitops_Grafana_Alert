# infrastructure/flux-image-automation — continuous deployment to dev, from Flux

Closes the GitOps loop for **dev only**: CI builds and pushes an image; Flux notices
the new tag in ACR and **commits the bump to git itself** (not a CI script). qa and
prod are promoted a different way — a reviewed PR — see the root README's CI/CD
section.

```
CI pushes  sanaksregistry.azurecr.io/user-management-app-api:dev-42
      │
ImageRepository (polls ACR every 1m, via acr-credentials)
      │
ImagePolicy "…-api-dev"  (numerical, pattern dev-<N>) → picks the highest N
      │
ImageUpdateAutomation "dev-images"
      │  rewrites the `# {"$imagepolicy": ...}` marker in
      │  apps/user-management-app/k8s/overlays/dev/kustomization.yaml
      │  commits + pushes to main (as flux-image-updater, via a GitHub PAT)
      ▼
Flux's normal `user-management-app-dev` Kustomization reconciles the new tag — same
as any other git change.
```

## One-time setup

### 1. Enable the two extra Flux components on the AKS extension

They ship the `image.toolkit.fluxcd.io` CRDs these files use, and are **off by default**:

```bash
az k8s-extension update -g san-rg -c san-dev-aks -t managedClusters --name flux \
  --config image-reflector-controller.enabled=true \
  --config image-automation-controller.enabled=true
```

Reconcile this Kustomization only *after* that command reports `Succeeded` — Flux
retries on its own either way, same as every other CRD-ordering case in this repo.

### 2. A GitHub PAT so Flux can push

Fine-grained PAT, this repo only, **Contents: Read and write**. Then:

```bash
bao kv put kv/flux/git-credentials username='<your-github-username>' password='<PAT>'
```

### 3. A scoped ACR pull token so Flux can list tags

```bash
az acr token create --registry sanaksregistry --name flux-pull-token \
  --scope-map _repositories_pull \
  --query "credentials.passwords[0].value" -o tsv
bao kv put kv/flux/acr-pull username='flux-pull-token' password='<the token value above>'
```

### 4. Widen the OpenBao policy to the new `kv/flux/*` path

```bash
bao policy write eso-monitoring - <<'EOF'
path "kv/data/monitoring/*"    { capabilities = ["read"] }
path "kv/data/user-management-app/*" { capabilities = ["read"] }
path "kv/data/flux/*"          { capabilities = ["read"] }
EOF
```

## Files

| File | Purpose |
|---|---|
| `git-repository.yaml` | a second, **write-capable** `GitRepository` (the AKS-managed one is read-only) + the `ExternalSecret` for its PAT |
| `acr-pull-secret.yaml` | `ExternalSecret` → a `dockerconfigjson` Secret so `image-reflector-controller` can list ACR tags |
| `imagerepositories.yaml` | one `ImageRepository` per image — polls ACR every 1m |
| `imagepolicies-dev.yaml` | one `ImagePolicy` per image, **dev only** — numerical, picks the highest `dev-<N>` |
| `imageupdateautomation.yaml` | the write-back: Setters strategy, commits + pushes to `main` |

## The Setters marker

In `apps/user-management-app/k8s/overlays/dev/kustomization.yaml`:

```yaml
images:
  - name: user-management-app-api
    newName: sanaksregistry.azurecr.io/user-management-app-api
    newTag: dev-41 # {"$imagepolicy": "flux-system:user-management-app-api-dev:tag"}
```

Only `newTag`'s value and the digit(s) are ever touched. The marker names the
`ImagePolicy` (`flux-system:user-management-app-api-dev`) it tracks. qa/prod overlays
have **no marker** — only a release/promotion PR can change their `newTag`.

## Verify

```bash
kubectl get imagerepository,imagepolicy,imageupdateautomation -n flux-system
kubectl describe imagerepository user-management-app-api -n flux-system   # tags discovered
kubectl describe imagepolicy user-management-app-api-dev -n flux-system   # LatestImage
kubectl -n flux-system logs deploy/image-automation-controller --tail=50  # commit attempts
git log --oneline -5   # look for "chore(dev): auto-update image tag(s)" from fluxcdbot
```

## Rollback

Every automated update is a plain git commit authored by `fluxcdbot`. To undo one:

```bash
git log --oneline --author=fluxcdbot -5
git revert <bad-commit-sha>
git push
```

Flux (both the automation and the regular `user-management-app-dev` Kustomization)
picks up the revert like any other commit — dev is back on the previous image within
one reconcile interval. See the root README's "Rollback" section for qa/prod.
