# Operations runbook — full teardown, full stand-up (all environments)

One linear, copy-paste checklist for the two operations you'll actually run over and
over: **kill everything to stop paying for it**, and **bring everything back — platform
plus all three app environments (dev, qa, prod) — from nothing.**

This doc doesn't replace the root [`README.md`](../README.md) — it's the condensed,
script-shaped version of §3 (build from scratch), §6 (CI/CD), and §14 (tear down) with
one addition those don't spell out end-to-end: **arming dev *and* qa *and* prod**, not
just dev. Every command below is the same command those sections already document;
follow the linked section for the *why* behind any step.

Replace `san-rg`, `san-dev-aks`, `sanaksregistry`, the subscription id, and the DNS
labels with your own — same placeholders as the rest of this repo.

---

## Part A — Full teardown

Deletes the whole resource group: AKS cluster, ACR, node pool, every LoadBalancer
public IP, every managed disk. Nothing left to bill for. This is the "Tier 4" option in
[§14](../README.md#14-tear-down-to-save-cost--and-stand-back-up) — see that section for
the lighter-weight tiers (pause-only, keep-the-cluster, etc.) if you don't want to lose
everything.

```bash
# 1. (optional but recommended) confirm you still have what Part B will need to rebuild:
#    - this git repo pushed to GitHub (it's your source of truth — nothing else is)
#    - your OpenBao root token + unseal keys, IF you want to reuse the exact same
#      secret values (you don't have to — Part B re-seeds fresh ones either way)
#    - your GitHub OIDC app registration and its federated credentials (§6) —
#      these live in Azure AD, NOT in the resource group, so they survive this step
#      untouched; you will NOT need to redo §6's one-time setup after this teardown

# 2. delete everything
az group delete -n san-rg --yes --no-wait

# 3. confirm it's gone (takes a few minutes in the background)
az group show -n san-rg 2>&1   # eventually: "ResourceGroupNotFound"
```

That's it — one command. Everything below (Part B) is what "stand back up" means.

---

## Part B — Full stand-up (platform + dev + qa + prod, all armed)

Ordered end to end. Each numbered step names the root README section with the full
explanation; the commands here are copy-paste-ready.

### B1. Recreate the resource group, ACR, and cluster

```bash
az group create -n san-rg -l eastus2
az acr create -g san-rg -n sanaksregistry --sku Basic
az aks create -g san-rg -n san-dev-aks \
  --node-count 2 --node-vm-size Standard_D2s_v6 \
  --attach-acr sanaksregistry --generate-ssh-keys
az aks get-credentials -g san-rg -n san-dev-aks
```

### B2. Build & push the app images ([§3.1](../README.md#31-build--push-the-app-images))

Only needed if ACR was deleted (Part A always deletes it — it's in the resource group).
**Test locally first**, per [apps/user-management-app/README.md → Local Docker Desktop
test](../apps/user-management-app/README.md#local-docker-desktop-test) and
[docs/local-observability.md](../apps/user-management-app/docs/local-observability.md)
if you're touching anything telemetry-related.

```bash
az acr build --registry sanaksregistry --image user-management-app-api:v1 ./apps/user-management-app/api
az acr build --registry sanaksregistry --image user-management-app-ui:v1  ./apps/user-management-app/ui
```

### B3. RBAC for every namespace, *before* installing Flux ([§3.6](../README.md#36-one-time-rbac-for-the-new-namespaces))

```bash
for ns in monitoring openbao external-secrets cnpg-system \
          user-management-app-dev-ns user-management-app-qa-ns user-management-app-prod-ns; do
  kubectl create namespace "$ns" --dry-run=client -o yaml | kubectl apply -f -
  kubectl create serviceaccount flux-applier -n "$ns" --dry-run=client -o yaml | kubectl apply -f -
  kubectl create clusterrolebinding "flux-applier-$ns" --clusterrole=cluster-admin \
    --serviceaccount="$ns:flux-applier" --dry-run=client -o yaml | kubectl apply -f -
done
```

### B4. Install the Flux extension + every Kustomization ([§3.5](../README.md#35-install-the-flux-extension--configuration-on-aks))

```bash
az provider register --namespace Microsoft.KubernetesConfiguration

az k8s-extension create \
  -g san-rg -c san-dev-aks -t managedClusters \
  --name flux --extension-type microsoft.flux

az k8s-configuration flux create \
  -g san-rg -c san-dev-aks -t managedClusters \
  --name platform-config --namespace flux-system \
  --url <YOUR_REPO_URL> --branch main \
  --kustomization name=prometheus               path=./infrastructure/prometheus      prune=true \
  --kustomization name=external-secrets-operator path=./infrastructure/secrets/operator prune=true \
  --kustomization name=openbao                  path=./infrastructure/secrets/openbao prune=true \
  --kustomization name=secrets                  path=./infrastructure/secrets         prune=true dependsOn=\["external-secrets-operator","openbao","prometheus"\] \
  --kustomization name=grafana-operator         path=./infrastructure/grafana/operator prune=true dependsOn=\["prometheus"\] \
  --kustomization name=grafana                  path=./infrastructure/grafana         prune=true dependsOn=\["grafana-operator","secrets"\] \
  --kustomization name=alert                    path=./infrastructure/alert           prune=true dependsOn=\["prometheus","secrets"\] \
  --kustomization name=observability            path=./infrastructure/observability   prune=true dependsOn=\["prometheus","grafana"\] \
  --kustomization name=cnpg-operator            path=./infrastructure/cnpg            prune=true \
  --kustomization name=user-management-app-dev  path=./apps/user-management-app/k8s/overlays/dev  prune=true dependsOn=\["cnpg-operator","secrets"\] \
  --kustomization name=user-management-app-qa   path=./apps/user-management-app/k8s/overlays/qa   prune=true dependsOn=\["cnpg-operator","secrets"\] \
  --kustomization name=user-management-app-prod path=./apps/user-management-app/k8s/overlays/prod prune=true dependsOn=\["cnpg-operator","secrets"\] \
  --kustomization name=flux-image-automation    path=./infrastructure/flux-image-automation prune=true dependsOn=\["secrets"\]

# lock the 3 app envs — the AKS CLI wrapper has no --suspend flag, they come up armed
for k in dev qa prod; do
  kubectl -n flux-system patch kustomization "platform-config-user-management-app-$k" \
    --type merge -p '{"spec":{"suspend":true}}'
done
```

> **`observability` is WIP** — see
> [`infrastructure/observability/README.md`](../infrastructure/observability/README.md).
> It's a leaf in the dependency graph (nothing `dependsOn`s it), so if it fails to
> reconcile it will **not** block anything else in this list — everything else still
> comes up. Drop that one `--kustomization` line entirely if you'd rather stand up
> without it for now.

### B5. Bootstrap OpenBao once ([§3.7](../README.md#37-wait-then-bootstrap-openbao), full commands in [infrastructure/secrets/README.md](../infrastructure/secrets/README.md#bootstrap-openbao-one-time--first-install-or-after-any-tier--2-rebuild))

```bash
kubectl get pods -n openbao -w        # openbao-0 Running but 0/1 -> starts SEALED, expected
```

Follow the linked bootstrap block: init → unseal (save the keys + root token somewhere
safe) → enable KV v2 + Kubernetes auth → write the policy → seed every value:

```bash
bao kv put kv/monitoring/gmail-smtp    password='YOUR_GMAIL_APP_PASSWORD'
bao kv put kv/monitoring/grafana-admin password='A_STRONG_ADMIN_PASSWORD'
bao kv put kv/user-management-app/jwt  secret="$(openssl rand -hex 32)"
# + kv/flux/git-credentials and kv/flux/acr-pull — see
#   infrastructure/flux-image-automation/README.md
```

### B6. Confirm the platform converged

```bash
kubectl get externalsecret -n monitoring     # gmail-smtp-secret, grafana-admin -> SecretSynced=True
kubectl get kustomization -n flux-system     # all READY=True except the 3 suspended app ones
kubectl get pods -n monitoring               # prometheus-*, alertmanager-*, grafana-*, *-operator-*
kubectl get svc grafana-service -n monitoring -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
```

Grafana: `http://<your DNS label>.eastus2.cloudapp.azure.com`, `admin` / the password
you just seeded.

### B7. CI/CD one-time setup ([§6](../README.md#6-cicd-pipeline))

Skip this whole step if you already did it before Part A — it's all Azure AD +
GitHub config, none of it lives in the resource group you just deleted:

1. GitHub OIDC app + federated credentials + role assignments
2. Repo → Settings → Variables: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
   `AZURE_SUBSCRIPTION_ID`, `ACR_NAME`, `AKS_RESOURCE_GROUP`, `AKS_CLUSTER_NAME`,
   `FLUX_KUSTOMIZATION_PREFIX=platform-config-`
3. Repo → Settings → Environments → `production` (+ optional `qa`)
4. `kv/flux/git-credentials` and `kv/flux/acr-pull` in OpenBao (part of B5 above if you
   skipped it there)

### B8. Arm all three environments — dev, then qa, then prod

This is the step the rest of the repo's docs don't spell out as one sequence — each
`promote-*` workflow is documented on its own, but standing everything up means running
all three, in order, with a real release in between:

```bash
# 1. dev — arms it; Flux Image Automation takes over from here on every new dev-<N> tag
gh workflow run promote-dev.yml

# 2. cut a real release so qa/prod have an image tag to promote
git tag v1.0.0 && git push --tags        # triggers release.yml: build, scan, push v1.0.0

# 3. qa — verifies the tag exists in ACR, opens a PR bumping the qa overlay, arms qa
gh workflow run promote-qa.yml -f version=v1.0.0
#    merge the PR it opens, then either wait up to 1h (qa's reconcile interval) or:
flux reconcile kustomization platform-config-user-management-app-qa -n flux-system

# 4. prod — same shape, gated by the "production" GitHub Environment's required reviewers
gh workflow run promote-prod.yml -f version=v1.0.0
#    merge the PR it opens, then:
flux reconcile kustomization platform-config-user-management-app-prod -n flux-system
```

(No `gh` CLI? Every one of these is also just Actions tab → the named workflow → **Run
workflow**, with the same `version` input — see
[§6 → Running a promotion](../README.md#running-a-promotion).)

### B9. Verify all three are actually up

```bash
kubectl get pods -n user-management-app-dev-ns
kubectl get pods -n user-management-app-qa-ns
kubectl get pods -n user-management-app-prod-ns

for env in dev qa prod; do
  echo "== $env =="
  curl -s "http://user-management-$env.eastus2.cloudapp.azure.com/api/healthz"
done
```

Log into each UI (`admin` / `password123`) and confirm the user list loads. In Grafana,
**Dashboards → Custom Application Dashboards → User Management App**, use the
**Namespace** picker to switch between all three.

If `infrastructure/observability` was included in B4, also check
[its README's first-deploy checklist](../infrastructure/observability/README.md#known-gaps-before-this-is-real-first-deploy-checklist)
before trusting logs/traces are flowing.

---

## At a glance

```
TEARDOWN                                    STAND-UP
─────────                                   ─────────
az group delete                             az group create + acr create + aks create
                                             az acr build (api, ui)              [skip if images survived]
                                             RBAC loop (7 namespaces)            §3.6
                                             az k8s-extension create + flux create  §3.5
                                             suspend dev/qa/prod
                                             OpenBao bootstrap                   §3.7
                                             confirm convergence
                                             CI/CD one-time setup                [skip if already done]  §6
                                             promote-dev  ─▶  git tag  ─▶  promote-qa  ─▶  promote-prod
                                             verify all 3 envs + Grafana
```
