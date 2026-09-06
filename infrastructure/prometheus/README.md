# infrastructure/prometheus — metrics + alerting backend

Installs **kube-prometheus-stack** (Prometheus + Prometheus Operator + Alertmanager +
node-exporter + kube-state-metrics) via a Flux HelmRelease. Reconciled by
`clusters/dev/prometheus.yaml`. `grafana` and `alert` both `dependsOn` this.

```
namespace.yaml              the monitoring namespace
kube-prometheus-stack.yaml  HelmRepository + HelmRelease
```

Key chart values (`kube-prometheus-stack.yaml`):

| Value | Why |
|-------|-----|
| `grafana.enabled: false` | Dashboards come from the Grafana Operator (`../grafana/`). |
| `alertmanager.alertmanagerSpec.alertmanagerConfigSelector: {}` + `...NamespaceSelector: {}` + `alertmanagerConfigMatcherStrategy.type: None` | Pick up `AlertmanagerConfig` CRs from any namespace and let the CR's route be the real root route. |
| `prometheus.prometheusSpec.serviceMonitorSelector / ruleSelector` = `{}` (+ namespace selectors) | Discover `ServiceMonitor` and `PrometheusRule` CRs in any namespace, not just the chart's own labelled ones. |

## Verify

```bash
kubectl get helmrelease -n monitoring kube-prom-stack
kubectl get pods -n monitoring          # prometheus-*, alertmanager-*, kube-state-metrics, node-exporter
kubectl port-forward -n monitoring svc/kube-prom-stack-kube-prome-prometheus 9090:9090
# http://localhost:9090/targets  → the nginx-demo job should be UP
```
