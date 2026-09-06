# AKS GitOps Demo — nginx + kube-prometheus-stack via Flux

Minimal nginx app deployed to AKS via Flux + Kustomize, with Prometheus/Grafana/Alertmanager
installed as a Flux-managed Helm release.

## Structure

```
docker/                          Dockerfile + static site for the nginx image
apps/nginx-demo/base/            Base Deployment + Service (Kustomize)
apps/nginx-demo/overlays/dev/    Dev overlay (replica count patch)
infrastructure/monitoring/       HelmRepository + HelmRelease for kube-prometheus-stack
clusters/dev/                    Flux Kustomization CRDs (what Flux reconciles)
```

# AKS GitOps Demo — nginx + kube-prometheus-stack via Flux (Operator Model)

Nginx app deployed to AKS via Flux + Kustomize, with Prometheus/Grafana/Alertmanager
installed as a Flux-managed Helm release. Alerting follows the **Kubernetes Operator
pattern** end to end — no Azure-native monitoring (Azure Monitor / Managed Prometheus /
Azure Managed Grafana) is used anywhere in this repo. All scrape targets and alert
routing are declared as Kubernetes custom resources (`ServiceMonitor`, `PrometheusRule`,
`AlertmanagerConfig`) that the Prometheus Operator (bundled in kube-prometheus-stack)
reconciles automatically.

## Structure

```
docker/                              Dockerfile, static site, nginx config (stub_status enabled)
apps/nginx-demo/base/
  deployment.yaml                    nginx + nginx-prometheus-exporter sidecar
  service.yaml                       exposes both the app port and the metrics port
  servicemonitor.yaml                tells Prometheus Operator to scrape the exporter
apps/nginx-demo/overlays/dev/        Dev overlay (replica count patch)
infrastructure/monitoring/
  helmrepository.yaml, helmrelease.yaml   kube-prometheus-stack, cross-namespace CRD discovery enabled
  nginx-alert-rule.yaml              PrometheusRule — alert conditions
  alertmanagerconfig.yaml            AlertmanagerConfig — routing + email receiver (operator-native)
clusters/dev/                        Flux Kustomization CRDs (what Flux reconciles)
```

## Operator-model architecture

```
nginx-demo pod (2 containers: nginx + nginx-prometheus-exporter)
      │ exposes :9113/metrics
      ▼
ServiceMonitor (apps/nginx-demo/base/servicemonitor.yaml)
      │ Prometheus Operator auto-discovers via label selector, no manual scrape config
      ▼
Prometheus (scrapes metrics, evaluates PrometheusRule)
      │
PrometheusRule (infrastructure/monitoring/nginx-alert-rule.yaml)
      │ fires alerts: NginxPodRestarting, NginxPodNotReady, NginxExporterTargetDown
      ▼
Alertmanager ← AlertmanagerConfig (infrastructure/monitoring/alertmanagerconfig.yaml)
      │ routing + receiver defined as a CR, not embedded in Helm values
      ▼
Email (Gmail SMTP, password via a Kubernetes Secret referenced directly — no file mounts)
```

Two Helm values enable this pattern (in `helmrelease.yaml`):
- `prometheus.prometheusSpec.serviceMonitorSelector: {}` / `serviceMonitorNamespaceSelector: {}`
  — without these, Prometheus only picks up `ServiceMonitor`s matching the chart's own
  restrictive default labels, in its own namespace only.
- `alertmanager.alertmanagerSpec.alertmanagerConfigSelector: {}` / `alertmanagerConfigNamespaceSelector: {}`
  / `alertmanagerConfigMatcherStrategy.type: None` — the last one is important: without it,
  Prometheus Operator auto-injects a `namespace=<AlertmanagerConfig's own namespace>` matcher
  onto every `AlertmanagerConfig`'s route, which silently breaks routing if your alerts carry
  a different `namespace` label (e.g. alerts about pods in `default` but the `AlertmanagerConfig`
  object lives in `monitoring`). `type: None` makes the CR's route the actual root route,
  ignoring that auto-matcher entirely.

## Before you push

1. Image path is already set to `sanaksregistry.azurecr.io/nginx-demo:v1` in
   `apps/nginx-demo/base/deployment.yaml`. Rebuild and push the image (it now bakes in
   `default.conf` with `stub_status` enabled — required for the exporter sidecar to work).
2. Create the Gmail SMTP secret directly on the cluster (never commit it to git):
   ```bash
   kubectl create secret generic gmail-smtp-secret \
     --namespace monitoring \
     --from-literal=password='YOUR_GMAIL_APP_PASSWORD'
   ```
   `alertmanagerconfig.yaml` references this secret directly via `authPassword.name`/`key`
   — no file mount, no `alertmanager.alertmanagerSpec.secrets` list needed. This is the
   operator-native way of doing it: the Operator reads the Secret via the Kubernetes API
   when reconciling the `AlertmanagerConfig`, rather than the raw-config approach of
   mounting a file into the pod.
3. Change `grafana.adminPassword` in `helmrelease.yaml` to something real, or switch to a Secret.

## Build and push the image

```bash
cd docker
docker build -t nginx-demo:v1 .
az acr login --name sanaksregistry
docker tag nginx-demo:v1 sanaksregistry.azurecr.io/nginx-demo:v1
docker push sanaksregistry.azurecr.io/nginx-demo:v1
az aks update --resource-group san-rg --name san-dev-aks --attach-acr sanaksregistry
```

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
  --kustomization name=apps path=./apps/nginx-demo/overlays/dev prune=true \
  --kustomization name=infrastructure path=./infrastructure/monitoring prune=true
```

## Verify

```bash
kubectl get gitrepository -n flux-system
kubectl get kustomization -n flux-system
kubectl get pods -n default              # should show 2/2 (nginx + exporter) per pod
kubectl get pods -n monitoring
kubectl get servicemonitor -n default
kubectl get prometheusrule -n monitoring
kubectl get alertmanagerconfig -n monitoring
kubectl get svc nginx-demo-svc --watch
```

## Access Grafana

```bash
kubectl port-forward -n monitoring svc/kube-prom-stack-grafana 3000:80
```
Visit http://localhost:3000 (user: `admin`, password: value of `grafana.adminPassword`).

## Confirm the ServiceMonitor is actually being scraped

```bash
kubectl port-forward -n monitoring svc/kube-prom-stack-kube-prome-prometheus 9090:9090
```
Visit http://localhost:9090/targets and look for a `nginx-demo` job — it should show
`UP` for each pod. If it's missing entirely, check that `prometheus.prometheusSpec.serviceMonitorNamespaceSelector`
is set to `{}` (see architecture note above) and that the `ServiceMonitor`'s label
selector (`app: nginx-demo`) matches the Service's labels.

## Alert rules

`infrastructure/monitoring/nginx-alert-rule.yaml` defines:

- **NginxPodRestarting** — fires if any `nginx-demo` pod's container restart count
  increases within a 5-minute window.
- **NginxPodNotReady** — fires if fewer than 2 `nginx-demo` pods are Ready for 2+ minutes.
- **NginxExporterTargetDown** — fires if Prometheus can't scrape the exporter sidecar
  at all (`up{job="nginx-demo"} == 0`) — this one specifically exercises the `ServiceMonitor`.

All three route through `infrastructure/monitoring/alertmanagerconfig.yaml`'s
`email-notifications` receiver → `parasisandesh@hotmail.com`, sent via Gmail SMTP.
Every `PrometheusRule` needs the label `release: kube-prom-stack` — required for the
chart's default rule selector to pick it up.

### Test NginxPodRestarting (GitOps-driven)

```bash
kubectl exec -n default deploy/nginx-demo -- sh -c "kill 1"
kubectl get pods -n default -w
```
This kills the main nginx process inside one pod (`RESTARTS` goes from 0 to 1).

Or test via git: temporarily reduce `initialDelaySeconds`/`periodSeconds` on the
readiness/liveness probes in `apps/nginx-demo/base/deployment.yaml`, commit, push —
an overly aggressive probe causes Kubernetes to restart the container once Flux applies it.

### Test NginxExporterTargetDown

```bash
kubectl exec -n default deploy/nginx-demo -c nginx-exporter -- kill 1
```
Kills just the exporter sidecar without touching nginx itself — Prometheus should
mark the target `down` within one scrape interval (15s) and fire after 2 minutes.

### Check it fired

```bash
kubectl port-forward -n monitoring svc/kube-prom-stack-kube-prome-alertmanager 9093:9093
```
Visit http://localhost:9093 — the alert should appear as `Pending` then `Firing`
within 1-2 minutes, and an email should land at `parasisandesh@hotmail.com` shortly after.
If nothing arrives, check Alertmanager's logs for the exact SMTP error:
```bash
kubectl logs -n monitoring alertmanager-kube-prom-stack-kube-prome-alertmanager-0 -c alertmanager --tail=50
```

## Why Gmail instead of the recipient's own Outlook/Hotmail account as sender

Microsoft has disabled basic SMTP authentication for personal Outlook.com/Hotmail
consumer accounts — attempts fail with `535 5.7.139 Authentication unsuccessful,
basic authentication is disabled`, and there's no user-facing toggle to re-enable it
(only Microsoft 365 work/school tenants can, via the Exchange Admin Center). Gmail
still supports app-password SMTP auth for personal accounts with 2-Step Verification
enabled, so it's used as the sender while `parasisandesh@hotmail.com` remains the
recipient (receiving mail is unaffected by any of this).

