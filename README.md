# AKS GitOps: nginx + Grafana dashboards + Prometheus alerting, via Flux

A demo of running application observability the **operator + GitOps** way on AKS:

- an **nginx** app deployed to two namespaces (`dev`, `qa`) by **Flux + Kustomize**
- **Prometheus** (kube-prometheus-stack) scraping it
- **Grafana** dashboards managed by the **Grafana Operator** (custom resources, no clicking)
- **alerting** as **PrometheusRule + AlertmanagerConfig** custom resources → email

Everything is declared in this git repo. Nothing is `kubectl apply`-ed by hand, nothing
is configured in a UI, and no Azure-native monitoring (Azure Monitor / Managed Prometheus
/ Azure Managed Grafana) is used — this repo runs its **own** Prometheus + Grafana inside
the cluster.

- Grafana details & how to add dashboards → [`infrastructure/grafana/README.md`](infrastructure/grafana/README.md)
- Alerting details & how to add rules → [`infrastructure/alert/README.md`](infrastructure/alert/README.md)
- Prometheus backend → [`infrastructure/prometheus/README.md`](infrastructure/prometheus/README.md)

---

## 1. How it fits together

```
                    ┌──────────────────────── cluster: san-dev-aks ────────────────────────┐
                    │                                                                       │
 GitHub repo ──────►│  Flux (source-controller + kustomize-controller + helm-controller)    │
 (this repo, main)  │        │ pulls main every 10m, applies each Kustomization             │
                    │        ▼                                                              │
                    │  ┌─────────────┐   installs    ┌──────────────────────────────────┐   │
                    │  │ prometheus  │──────────────►│ kube-prometheus-stack (Helm)     │   │
                    │  │ Kustomizatn │               │  Prometheus + Prometheus Operator │   │
                    │  └─────────────┘               │  + Alertmanager                  │   │
                    │        ▲                        └──────────────────────────────────┘   │
                    │        │ dependsOn                        ▲            ▲                │
                    │  ┌─────────────┐  installs  ┌───────────┐ │            │               │
                    │  │grafana-oper.│───────────►│ Grafana   │ │ scrapes    │ evaluates     │
                    │  │ Kustomizatn │            │ Operator  │ │ Service-   │ Prometheus-   │
                    │  └─────────────┘            └───────────┘ │ Monitor    │ Rule          │
                    │        ▲                         │        │            │               │
                    │        │ dependsOn               │ builds │            │               │
                    │  ┌─────────────┐   apply    ┌────▼─────┐  │       ┌────┴─────────┐     │
                    │  │  grafana    │───────────►│ Grafana  │◄─┼───────│ nginx-demo   │     │
                    │  │ Kustomizatn │  Grafana/  │ instance │  │ data  │ pods (dev &  │     │
                    │  │             │  Datasource│ :3000    │  │ source│ qa namespaces)│    │
                    │  │             │  Dashboard/│          │  │       └──────┬───────┘     │
                    │  │             │  Folder CRs└──────────┘  │              │             │
                    │  └─────────────┘                          │              │ restart     │
                    │  ┌─────────────┐   apply   ┌───────────┐  │              ▼             │
                    │  │   alert     │──────────►│Prometheus │──┘        Alertmanager        │
                    │  │ Kustomizatn │ Prom.Rule │Rule +     │                 │             │
                    │  │ dependsOn   │ + Alert-  │Alertmgr   │                 ▼             │
                    │  │ prometheus  │ mgrConfig │Config     │      email (Gmail SMTP) ──────┼──► parasisandesh@hotmail.com
                    │  └─────────────┘           └───────────┘                               │
                    │  ┌─────────────┐  ┌─────────────┐                                      │
                    │  │    apps     │  │   apps-qa   │  deploy nginx-demo into              │
                    │  │ →dev overlay│  │ →qa overlay │  nginx-dev-app-ns / nginx-qa-app-ns  │
                    │  └─────────────┘  └─────────────┘                                      │
                    └───────────────────────────────────────────────────────────────────────┘
```

**The mechanism, in words:**

1. Flux's **source-controller** clones this repo and stores an artifact of the latest
   `main` commit.
2. For each **Flux Kustomization** (a small CR that says "render this path and apply it"),
   the **kustomize-controller** runs `kustomize build <path>` and server-side-applies the
   result, honouring `dependsOn` ordering.
3. Two of those Kustomizations apply a **HelmRelease**; the **helm-controller** installs
   the chart (kube-prometheus-stack, grafana-operator). Those charts include **operators**
   — controllers that watch **custom resources** and turn them into running objects:
   - **Prometheus Operator** watches `ServiceMonitor`, `PrometheusRule`,
     `AlertmanagerConfig` → configures Prometheus + Alertmanager.
   - **Grafana Operator** watches `Grafana`, `GrafanaDatasource`, `GrafanaFolder`,
     `GrafanaDashboard` → builds a Grafana Deployment and pushes dashboards/datasources
     into it over the Grafana HTTP API.
4. So adding a dashboard or an alert = commit a YAML file. Flux applies the CR, the
   operator reconciles it into the running system. No imperative steps.

---

## 2. Repository layout

```
apps/nginx-demo/
  base/                       deployment (nginx + nginx-prometheus-exporter sidecar),
                              service, servicemonitor  — environment-agnostic
  overlays/dev/               → namespace nginx-dev-app-ns, 2 replicas
  overlays/qa/                → namespace nginx-qa-app-ns, 1 replica

infrastructure/
  prometheus/                 kube-prometheus-stack Helm install + the monitoring namespace
    namespace.yaml
    kube-prometheus-stack.yaml
    kustomization.yaml
    README.md
  grafana/                    Grafana Operator + our Grafana instance + dashboards
    operator/                 the operator Helm install — its OWN Flux Kustomization
      grafana-operator.yaml
      kustomization.yaml
    grafana.yaml              Grafana instance CR + GrafanaDatasource CR (→ Prometheus)
    folder.yaml               GrafanaFolder "Custom Application Dashboards"
    dashboard.yaml            GrafanaDashboard CR (points at the ConfigMap, filed in the folder)
    json/nginx-demo.json      the dashboard model — plain Grafana JSON
    kustomization.yaml        bundles json/*.json into a ConfigMap + applies the CRs
    README.md
  alert/                      Prometheus alerting
    alertmanager-config.yaml  AlertmanagerConfig — routing + Gmail email receiver
    rules/                    one PrometheusRule file per alert
      nginx-restarts.yaml     NginxPodRestarting
    kustomization.yaml
    README.md

clusters/dev/                 reference copies of the Flux Kustomizations (see note below)
docker/                       Dockerfile + static site + nginx.conf (stub_status enabled)
```

### `clusters/dev/` vs the live Flux config

This cluster runs Flux through the **AKS Flux extension** (`microsoft.flux`), configured
by `az k8s-configuration flux` (see §4). That command defines the Flux Kustomizations
directly; the files under `clusters/dev/` are **human-readable equivalents** of the same
set, kept in the repo for review — they are not themselves applied here. On the cluster
every Kustomization is prefixed `nginx-demo-config-`:

| repo file | live Kustomization | path | dependsOn |
|---|---|---|---|
| `clusters/dev/apps.yaml` | `nginx-demo-config-apps` | `./apps/nginx-demo/overlays/dev` | — |
| `clusters/dev/apps-qa.yaml` | `nginx-demo-config-apps-qa` | `./apps/nginx-demo/overlays/qa` | — |
| `clusters/dev/prometheus.yaml` | `nginx-demo-config-infrastructure`¹ | `./infrastructure/prometheus` | — |
| `clusters/dev/grafana-operator.yaml` | `nginx-demo-config-grafana-operator` | `./infrastructure/grafana/operator` | `infrastructure` |
| `clusters/dev/grafana.yaml` | `nginx-demo-config-grafana` | `./infrastructure/grafana` | `grafana-operator` |
| `clusters/dev/alert.yaml` | `nginx-demo-config-alert` | `./infrastructure/alert` | `infrastructure` |

¹ The Prometheus Kustomization was first created as `infrastructure` and kept that name
on the cluster; the repo file was later renamed to `prometheus.yaml` for clarity. They
are the same thing. If you re-bootstrap from scratch (§4) it is called `prometheus`.

---

## 3. One-time prerequisites

### 3.1 Build & push the app image

```bash
cd docker
docker build -t nginx-demo:v1 .
az acr login --name sanaksregistry
docker tag nginx-demo:v1 sanaksregistry.azurecr.io/nginx-demo:v1
docker push sanaksregistry.azurecr.io/nginx-demo:v1
az aks update --resource-group san-rg --name san-dev-aks --attach-acr sanaksregistry
```

The image bakes in `docker/default.conf` with `stub_status` enabled — required for the
`nginx-prometheus-exporter` sidecar to produce metrics.

### 3.2 Create the Gmail SMTP secret (never commit it)

Alertmanager reads this to send alert email.

```bash
kubectl create namespace monitoring   # if it doesn't exist yet
kubectl create secret generic gmail-smtp-secret \
  --namespace monitoring \
  --from-literal=password='YOUR_GMAIL_APP_PASSWORD'
```

It's a Gmail **app password** (account with 2-Step Verification). Referenced by
`infrastructure/alert/alertmanager-config.yaml` → `spec.receivers[].emailConfigs[].authPassword`.
See §8 for why Gmail is the sender.

### 3.3 Change the Grafana admin password

Edit `admin_password` in `infrastructure/grafana/grafana.yaml` (demo value: `changeme123`).

---

## 4. Bootstrap Flux on AKS

```bash
az account set --subscription bf286ce3-6142-41dc-9c9b-fd993989df20

az provider register --namespace Microsoft.KubernetesConfiguration

az k8s-extension create \
  --resource-group san-rg --cluster-name san-dev-aks --cluster-type managedClusters \
  --name flux --extension-type microsoft.flux

az k8s-configuration flux create \
  --resource-group san-rg --cluster-name san-dev-aks --cluster-type managedClusters \
  --name nginx-demo-config --namespace flux-system \
  --url https://github.com/sandeshlamsal/Devops_Aks_Gitops_Grafana_Alert --branch main \
  --kustomization name=apps             path=./apps/nginx-demo/overlays/dev  prune=true \
  --kustomization name=apps-qa          path=./apps/nginx-demo/overlays/qa   prune=true \
  --kustomization name=prometheus       path=./infrastructure/prometheus     prune=true \
  --kustomization name=grafana-operator path=./infrastructure/grafana/operator prune=true dependsOn=["prometheus"] \
  --kustomization name=grafana          path=./infrastructure/grafana        prune=true dependsOn=["grafana-operator"] \
  --kustomization name=alert            path=./infrastructure/alert          prune=true dependsOn=["prometheus"]
```

**Managing an existing config** (`nginx-demo-config`) instead of recreating it:

```bash
# add a Kustomization
az k8s-configuration flux kustomization create -g san-rg -c san-dev-aks -t managedClusters \
  --name nginx-demo-config --kustomization-name apps-qa \
  --path ./apps/nginx-demo/overlays/qa --prune true

# change one (path / prune / depends-on)
az k8s-configuration flux kustomization update -g san-rg -c san-dev-aks -t managedClusters \
  --name nginx-demo-config --kustomization-name grafana --depends-on grafana-operator

# remove one
az k8s-configuration flux kustomization delete -g san-rg -c san-dev-aks -t managedClusters \
  --name nginx-demo-config --kustomization-name apps-qa --yes

# after each change, wait for the config to settle:
az k8s-configuration flux show -g san-rg -c san-dev-aks -t managedClusters \
  --name nginx-demo-config --query provisioningState -o tsv   # → Succeeded
```

> Only one operation runs at a time — if you see `ProvisioningState: Updating` / "conflict",
> wait for `Succeeded` and retry.

---

## 5. Day-to-day: how changes reach the cluster

1. Edit a file, commit, `git push origin main`.
2. Flux's source-controller notices within its poll interval (10 min) and the affected
   Kustomizations re-apply.
3. To not wait:

```bash
# refresh the git mirror, then re-apply everything that changed
flux reconcile source git nginx-demo-config -n flux-system

# or force one Kustomization
flux reconcile kustomization nginx-demo-config-grafana -n flux-system
flux reconcile kustomization nginx-demo-config-alert   -n flux-system
```

`prune=true` means **deleting a file also deletes the resource** on the next reconcile.

---

## 6. Verify the whole environment

```bash
# --- Flux ---
kubectl get gitrepository -n flux-system
kubectl get kustomization -n flux-system      # all READY=True, same revision
flux get kustomizations -n flux-system        # nicer view if the flux CLI is installed

# --- app, both environments ---
kubectl get pods -n nginx-dev-app-ns          # nginx-demo, 2 pods, 2/2 containers each
kubectl get pods -n nginx-qa-app-ns           # nginx-demo, 1 pod, 2/2
kubectl get servicemonitor -A | grep nginx-demo

# --- backend ---
kubectl get helmrelease -n monitoring         # kube-prom-stack + grafana-operator, READY
kubectl get pods -n monitoring                # prometheus-*, alertmanager-*, grafana-*, *-operator-*

# --- Grafana Operator CRs ---
kubectl get grafana,grafanadatasource,grafanafolder,grafanadashboard -n monitoring
#   grafana                → STAGE complete / success
#   grafanadatasource      → no "NO MATCHING INSTANCES"
#   grafanadashboard       → LAST RESYNC recent

# --- alerting CRs ---
kubectl get prometheusrule nginx-restarts -n monitoring
kubectl get alertmanagerconfig -n monitoring
```

### Check Prometheus is actually scraping the app

```bash
kubectl port-forward -n monitoring svc/kube-prom-stack-kube-prome-prometheus 9090:9090
# browser: http://localhost:9090/targets  → serviceMonitor/.../nginx-demo, one target per pod, all UP
# or:
curl -s 'http://localhost:9090/api/v1/targets?state=active' \
  | jq -r '.data.activeTargets[] | select(.labels.service=="nginx-demo-svc") | "\(.labels.namespace)\t\(.health)\t\(.labels.pod)"'
```

### Open our Grafana

> **This is our own in-cluster Grafana — not** the AKS portal's *Monitoring → Dashboards
> with Grafana* (that's Azure Managed Grafana, a separate instance on Azure's own
> Prometheus). Our custom dashboard only exists here.

`grafana-service` is a **`LoadBalancer`** (set in `infrastructure/grafana/grafana.yaml`):

```bash
kubectl get svc grafana-service -n monitoring \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}'      # → e.g. 20.161.101.114
```

| | URL |
|---|---|
| Grafana | `http://<EXTERNAL-IP>:3000` — currently **http://20.161.101.114:3000** |
| Nginx Dashboard | `http://<EXTERNAL-IP>:3000/d/nginx-demo/nginx-dashboard` |
| folder | `http://<EXTERNAL-IP>:3000/dashboards` → **Custom Application Dashboards** |

- login: **`admin` / `changeme123`** (`grafana.yaml` → `spec.config.security`)
- top-left **Namespace** dropdown → `nginx-dev-app-ns` / `nginx-qa-app-ns` / *All*

No exposure? `kubectl port-forward -n monitoring svc/grafana-service 3000:3000` → `http://localhost:3000`.

Quick API check:

```bash
IP=$(kubectl get svc grafana-service -n monitoring -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
curl -s -u admin:changeme123 "http://$IP:3000/api/health"
curl -s -u admin:changeme123 "http://$IP:3000/api/datasources/uid/prometheusdatasource/health"
curl -s -u admin:changeme123 "http://$IP:3000/api/search?type=dash-db"
```

> ⚠️ The IP is internet-facing with a demo password. Before real use: Secret-backed
> `admin_password` (`$__env{GF_SECURITY_ADMIN_PASSWORD}`), or ClusterIP + Ingress with
> auth — see [`infrastructure/grafana/README.md`](infrastructure/grafana/README.md#exposing-grafana).

---

## 7. End-to-end test: fire the alert

`NginxPodRestarting` fires when an `nginx-demo` container restarts in **any** namespace.

### 7.1 Trigger a restart

```bash
# dev:
kubectl exec -n nginx-dev-app-ns deploy/nginx-demo -c nginx-demo -- sh -c "kill 1"
# or qa:
kubectl exec -n nginx-qa-app-ns  deploy/nginx-demo -c nginx-demo -- sh -c "kill 1"

# watch the restart count tick 0 → 1
kubectl get pods -n nginx-qa-app-ns \
  -o custom-columns='POD:.metadata.name,RESTARTS:.status.containerStatuses[*].restartCount' -w
```

### 7.2 Watch it move inactive → pending → firing

```bash
kubectl port-forward -n monitoring svc/kube-prom-stack-kube-prome-prometheus 9090:9090 &
kubectl port-forward -n monitoring svc/kube-prom-stack-kube-prome-alertmanager 9093:9093 &

# Prometheus rule state (inactive → pending after ~1 scrape → firing after `for: 1m`)
watch -n5 'curl -s http://localhost:9090/api/v1/rules \
  | jq -r ".data.groups[].rules[] | select(.name==\"NginxPodRestarting\") | .state, (.alerts[]?.labels.namespace)"'

# Alertmanager (the alert appears here once firing)
curl -s http://localhost:9093/api/v2/alerts \
  | jq -r '.[] | select(.labels.alertname=="NginxPodRestarting") | "\(.labels.namespace)\t\(.status.state)"'
```

Expected timeline (observed): `inactive` → `pending` (~30s) → `firing` (~1m later),
then the alert shows up in Alertmanager tagged with the real namespace, and an email is
sent to `parasisandesh@hotmail.com`.

Browser equivalents: http://localhost:9090/alerts and http://localhost:9093

### 7.3 If no email arrives

```bash
kubectl logs -n monitoring alertmanager-kube-prom-stack-kube-prome-alertmanager-0 \
  -c alertmanager --tail=80 | grep -i -E 'smtp|email|notify'

# confirm the receiver is in Alertmanager's merged config
curl -s http://localhost:9093/api/v2/status | jq -r '.config.original' | grep -A15 'receivers:'

# confirm the secret exists and has the 'password' key
kubectl get secret gmail-smtp-secret -n monitoring -o jsonpath='{.data.password}' | base64 -d | head -c4; echo '...'
```

---

## 8. Multi-environment

`apps/nginx-demo/overlays/dev` and `.../qa` deploy the same `base` into
`nginx-dev-app-ns` and `nginx-qa-app-ns`. **Nothing in `infrastructure/` is
per-environment:**

- the `ServiceMonitor` ships with each overlay; Prometheus discovers it automatically
  (`serviceMonitorSelector: {}` / `serviceMonitorNamespaceSelector: {}` in the chart values)
- `NginxPodRestarting` matches the workload by container/pod name, not namespace
- the Grafana dashboard's **Namespace** variable is
  `label_values(kube_pod_info{pod=~"nginx-demo-.*"}, namespace)` — it lists whatever exists

**Add `staging`:**

```bash
cp -r apps/nginx-demo/overlays/qa apps/nginx-demo/overlays/staging
# edit overlays/staging/namespace.yaml   → name: nginx-staging-app-ns
# edit overlays/staging/kustomization.yaml → namespace: nginx-staging-app-ns
# (optionally tweak overlays/staging/replica-patch.yaml)
git add . && git commit -m "add staging overlay" && git push

az k8s-configuration flux kustomization create -g san-rg -c san-dev-aks -t managedClusters \
  --name nginx-demo-config --kustomization-name apps-staging \
  --path ./apps/nginx-demo/overlays/staging --prune true
```

No infra edits — the dashboard and alert pick it up on the next scrape.

---

## 9. Why Gmail is the email sender

Microsoft disabled basic SMTP auth for personal Outlook.com/Hotmail accounts
(`535 5.7.139 ... basic authentication is disabled`), with no user toggle to re-enable
it. Gmail still allows app-password SMTP for accounts with 2-Step Verification, so it is
used as the **sender** while `parasisandesh@hotmail.com` is only the **recipient**
(receiving is unaffected).

---

## 10. Troubleshooting

| Symptom | Check | Fix |
|---|---|---|
| Kustomization `READY=False`, "dependency not ready" | `kubectl get kustomization -n flux-system` | transient during reconcile; wait a cycle. If persistent, the dependency name is wrong in the `az` config. |
| `grafana` Kustomization: `dry-run failed: no matches for kind "GrafanaDashboard"` | is `grafana-operator` READY? `kubectl get crd | grep grafana` | the operator install must land first — that's why it is a **separate** Kustomization that `grafana` `dependsOn`. Reconcile `grafana-operator`, then `grafana`. |
| Dashboard/datasource not in Grafana | `kubectl describe grafanadashboard nginx-demo -n monitoring` | look at `status.conditions`. "NO MATCHING INSTANCES" ⇒ the `instanceSelector` labels don't match the `Grafana` CR's labels (`dashboards: "grafana"`). |
| Panels empty | datasource health (`/api/datasources/uid/prometheusdatasource/health`), and Prometheus `/targets` | if targets are missing, the `ServiceMonitor` selector or the Service labels are off. |
| Alert never fires | `http://localhost:9090/rules` — is `NginxPodRestarting` listed? its query value? | `PrometheusRule` needs label `release: kube-prom-stack`. Check the expr returns > 0 in `/graph`. |
| Alert fires, no email | §7.3 | secret missing/renamed, or Gmail app password wrong/expired. |
| `az ... flux ...` → "conflict / Updating" | `az k8s-configuration flux show ... --query provisioningState` | wait for `Succeeded`, retry. |
| Deleted a file but the resource is still on the cluster | is `prune=true` on that Kustomization? | `az k8s-configuration flux kustomization update ... --prune true` |
