# AKS GitOps Demo — nginx + Grafana + Prometheus alerting, all via Flux

An nginx app on **AKS**, deployed by **Flux + Kustomize**. Metrics with Prometheus,
dashboards with the **Grafana Operator**, alerting with **Prometheus + Alertmanager** —
everything declared as Kubernetes custom resources in git, nothing clicked in a UI, no
Azure-native monitoring.

## Layout

```
apps/nginx-demo/            the nginx app (deployment + service + ServiceMonitor)
  base/                     base manifests
  overlays/dev/             dev overlay (replica count)

infrastructure/
  prometheus/               BACKEND       — reconciled by clusters/dev/prometheus.yaml
    namespace.yaml          the monitoring namespace
    kube-prometheus-stack.yaml   Prometheus + Prometheus Operator + Alertmanager
  grafana/                  VIEW METRICS
    operator/               Grafana Operator install — reconciled by clusters/dev/grafana-operator.yaml
    grafana.yaml            Grafana instance + Prometheus datasource   \
    json/nginx-demo.json    dashboard model (plain JSON)                > reconciled by clusters/dev/grafana.yaml
    dashboard.yaml          GrafanaDashboard CR → ConfigMap from json/ /
  alert/                    ALERTING      — reconciled by clusters/dev/alert.yaml
    alertmanager-config.yaml  AlertmanagerConfig — routing + email receiver
    rules/nginx-restarts.yaml PrometheusRule — NginxPodRestarting

clusters/dev/              the Flux Kustomizations (apps, prometheus, grafana-operator, grafana, alert)
docker/                    Dockerfile + static site + nginx config (stub_status on)
```

Each `infrastructure/` folder has its own README with the details.

Flux apply order: `prometheus` → `grafana-operator` → `grafana`; `alert` also waits on
`prometheus`. Splitting the operator into its own Kustomization is what lets its CRDs
register before the `Grafana` / `GrafanaDashboard` CRs are applied.

## How it fits together

```
nginx-demo pods ──/metrics──▶ Prometheus ──────────datasource──────────▶ Grafana
                                   │                                        dashboards
                                   │ evaluates alert/rules/nginx-restarts.yaml (PrometheusRule)
                                   ▼
                              Alertmanager ◀── alert/alertmanager-config.yaml (AlertmanagerConfig)
                                   │ NginxPodRestarting fires
                                   ▼
                    email (Gmail SMTP) → parasisandesh@hotmail.com
```

Flux applies five Kustomizations: `apps` and `prometheus`, then `grafana-operator`
(dependsOn `prometheus`), then `grafana` (dependsOn `grafana-operator`); `alert` also
dependsOn `prometheus`. The app runs in its own namespace, `nginx-dev-app-ns`.

## Before you push

1. **Image** — build and push the nginx image (bakes in `default.conf` with `stub_status`
   enabled):
   ```bash
   cd docker
   docker build -t nginx-demo:v1 .
   az acr login --name sanaksregistry
   docker tag nginx-demo:v1 sanaksregistry.azurecr.io/nginx-demo:v1
   docker push sanaksregistry.azurecr.io/nginx-demo:v1
   az aks update --resource-group san-rg --name san-dev-aks --attach-acr sanaksregistry
   ```
2. **Gmail SMTP secret** — Alertmanager reads it to send alert email. Never commit it:
   ```bash
   kubectl create namespace monitoring   # if it doesn't exist yet
   kubectl create secret generic gmail-smtp-secret \
     --namespace monitoring \
     --from-literal=password='YOUR_GMAIL_APP_PASSWORD'
   ```
   Referenced by `infrastructure/alert/alertmanager-config.yaml` via `authPassword`.
3. **Grafana admin password** — change `admin_password` in
   `infrastructure/grafana/grafana.yaml`.

## Enable Flux on AKS and point it at this repo

```bash
az provider register --namespace Microsoft.KubernetesConfiguration

az k8s-extension create \
  --resource-group san-rg \
  --cluster-name san-dev-aks \
  --cluster-type managedClusters \
  --name flux \
  --extension-type microsoft.flux

az k8s-configuration flux create \
  --resource-group san-rg \
  --cluster-name san-dev-aks \
  --cluster-type managedClusters \
  --name nginx-demo-config \
  --namespace flux-system \
  --url https://github.com/sandeshlamsal/Devops_Aks_Gitops_Grafana_Alert \
  --branch main \
  --kustomization name=apps            path=./apps/nginx-demo/overlays/dev prune=true \
  --kustomization name=prometheus      path=./infrastructure/prometheus    prune=true \
  --kustomization name=grafana-operator path=./infrastructure/grafana/operator prune=true dependsOn=["prometheus"] \
  --kustomization name=grafana         path=./infrastructure/grafana       prune=true dependsOn=["grafana-operator"] \
  --kustomization name=alert           path=./infrastructure/alert         prune=true dependsOn=["prometheus"]
```

## Verify

```bash
kubectl get kustomization -n flux-system
kubectl get pods -n nginx-dev-app-ns                     # nginx-demo, 2/2 per pod
kubectl get pods -n monitoring                  # prometheus, alertmanager, grafana, grafana-operator
kubectl get grafana,grafanadashboard -n monitoring
kubectl get prometheusrule,alertmanagerconfig -n monitoring
```

## Access Grafana

```bash
kubectl port-forward -n monitoring svc/grafana-service 3000:3000
```
http://localhost:3000 — `admin` / `admin_password` from `infrastructure/grafana/grafana.yaml`.
Dashboard: **nginx-demo pods** (CPU / memory / restarts per pod).

## Test the alert

```bash
kubectl exec -n nginx-dev-app-ns deploy/nginx-demo -- sh -c "kill 1"     # restarts one pod
kubectl port-forward -n monitoring svc/kube-prom-stack-kube-prome-alertmanager 9093:9093
```
`NginxPodRestarting` shows Pending → Firing at http://localhost:9093 within ~1–2 minutes,
then an email is sent. If none arrives:
```bash
kubectl logs -n monitoring alertmanager-kube-prom-stack-kube-prome-alertmanager-0 -c alertmanager --tail=50
```

## Why Gmail as the sender

Microsoft disabled basic SMTP auth for personal Outlook.com/Hotmail accounts
(`535 5.7.139 ... basic authentication is disabled`), with no user toggle to re-enable it.
Gmail still allows app-password SMTP for accounts with 2-Step Verification, so it sends
while `parasisandesh@hotmail.com` just receives.
