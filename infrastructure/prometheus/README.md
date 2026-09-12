# infrastructure/prometheus — metrics & alerting backend

Installs **kube-prometheus-stack** via a Flux `HelmRelease`: Prometheus + the Prometheus
Operator + Alertmanager + node-exporter + kube-state-metrics. Everything else builds on
this — `grafana` reads Prometheus as a datasource, `alert` adds `PrometheusRule` /
`AlertmanagerConfig` CRs that this chart's operator reconciles.

Reconciled by the Flux Kustomization at path `./infrastructure/prometheus` (named
`prometheus` in `clusters/dev/` and in a fresh bootstrap; the live cluster kept the
original name `infrastructure` — same thing, see the root README §2).

`grafana-operator` and `alert` both `dependsOn` this Kustomization.

---

## Files

| File | Purpose |
|---|---|
| `namespace.yaml` | the `monitoring` namespace — everything monitoring-related lands here |
| `kube-prometheus-stack.yaml` | `HelmRepository` (prometheus-community) + `HelmRelease` (`kube-prom-stack`) |
| `kustomization.yaml` | applies the two files above |

---

## Chart values that matter (`kube-prometheus-stack.yaml`)

| Value | Why |
|---|---|
| `grafana.enabled: false` | dashboards come from the Grafana Operator (`../grafana/`), not this chart's bundled Grafana — one Grafana on the cluster |
| `prometheus.prometheusSpec.serviceMonitorSelector: {}` + `serviceMonitorNamespaceSelector: {}` | discover **every** `ServiceMonitor` in **every** namespace — so `apps/user-management-app/k8s/base/api.yaml's ServiceMonitor` is picked up wherever an overlay deploys it |
| `prometheus.prometheusSpec.ruleSelector: {}` + `ruleNamespaceSelector: {}` | same, for `PrometheusRule` CRs |
| `alertmanager.alertmanagerSpec.alertmanagerConfigSelector: {}` + `alertmanagerConfigNamespaceSelector: {}` | discover every `AlertmanagerConfig` CR |
| `alertmanager.alertmanagerSpec.alertmanagerConfigMatcherStrategy.type: None` | the `AlertmanagerConfig`'s own `route` becomes the true root route — no auto-injected `namespace=` matcher that would otherwise scope routing to the CR's namespace |
| `alertmanager...config.route.receiver: "null"` (+ a `null` receiver) | a valid empty default; real routing is added by `../alert/alertmanager-config.yaml` |
| `prometheus.prometheusSpec.retention: 5d` | small demo footprint |

> `PrometheusRule` CRs still need `labels.release: kube-prom-stack` — the chart's default
> rule selector matches that label even with `ruleSelector: {}` set on some versions.
> Keep the label on every rule to be safe.

---

## How discovery works (why new namespaces "just work")

```
overlay deploys:  Service + ServiceMonitor (selector app=user-management-app-api)
                        │
Prometheus Operator ────┘  serviceMonitorNamespaceSelector:{} → looks in ALL namespaces
                        │  serviceMonitorSelector:{}          → matches ALL ServiceMonitors
                        ▼
   writes a scrape job into Prometheus  → new pods scraped within one interval (15s)
```

So a `staging` overlay in `user-management-app-staging-ns` needs **no** change here.

---

## Verify

```bash
kubectl get helmrelease kube-prom-stack -n monitoring          # READY=True
kubectl get pods -n monitoring | grep -E 'prometheus|alertmanager|kube-state|node-exporter|operator'

kubectl port-forward -n monitoring svc/kube-prom-stack-kube-prome-prometheus 9090:9090
#   http://localhost:9090/targets   → user-management-app-api targets, one per pod, UP
#   http://localhost:9090/rules     → UserManagementAppPodRestarting listed
#   http://localhost:9090/config    → scrape configs

# Alertmanager
kubectl port-forward -n monitoring svc/kube-prom-stack-kube-prome-alertmanager 9093:9093
#   http://localhost:9093           → active alerts
curl -s http://localhost:9093/api/v2/status | jq -r '.config.original' | head -40
```

## Upgrade the chart

Bump `spec.chart.spec.version` in `kube-prometheus-stack.yaml`, commit, push,
`flux reconcile kustomization platform-config-prometheus -n flux-system`. The
helm-controller runs the upgrade; CRDs are updated by the chart's own CRD job.
