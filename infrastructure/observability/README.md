# infrastructure/observability — logs & traces, the operator way

Metrics already exist here: `infrastructure/prometheus/` (kube-prometheus-stack) scrapes
every `ServiceMonitor` in the cluster, `user-management-app-api`'s included
(`apps/user-management-app/k8s/base/api.yaml`). This folder adds the other two signals —
**logs** and **traces** — following the same pattern used everywhere else in this repo:
Flux applies CRs, an operator (here: the Prometheus/Grafana/Helm operators already
running) turns them into real workloads.

Every component here was proven working first in a plain local Docker Compose rig —
see [`apps/user-management-app/docs/local-observability.md`](../../apps/user-management-app/docs/local-observability.md)
for the guided walkthrough, the architecture diagram, and real captured example output.
This folder is that same architecture translated to AKS/Flux/Helm.

**Status: WIP, not yet validated on a live cluster.** `kustomize build` passes (that
only checks the YAML is well-formed); nothing here has been reconciled by a real Flux
install yet. Expect at least one real-deploy fix, same as every other piece of this repo
— see each infra folder's own history for examples (RBAC gaps, image path typos, API
version drift). Treat the "not yet validated" notes inline as the starting checklist for
that first deploy.

---

## Files

| Path | Kind | Purpose |
|---|---|---|
| `helmrepositories.yaml` | `HelmRepository` ×2 | chart sources: Grafana Labs (Loki/Tempo/Alloy) and CNCF (OTel Collector) |
| `loki.yaml` | `HelmRelease` | Loki, SingleBinary + filesystem storage — log storage |
| `tempo.yaml` | `HelmRelease` | Tempo, local storage backend — trace storage |
| `otel-collector.yaml` | `HelmRelease` + `ServiceMonitor` | receives OTLP traces from the app, forwards to Tempo |
| `alloy.yaml` | `HelmRelease` | Grafana Alloy DaemonSet — tails every pod's logs via the Kubernetes API, ships JSON lines to Loki |
| `datasource-loki.yaml` | `GrafanaDatasource` | wires Loki into the existing Grafana instance (`infrastructure/grafana/grafana.yaml`), with a derived field that turns a logged `trace_id` into a link into Tempo |
| `datasource-tempo.yaml` | `GrafanaDatasource` | wires Tempo into the same Grafana instance, with the reverse link (trace → its logs) |

Reconciled by the **`observability`** Flux Kustomization
(`clusters/dev/observability.yaml`, path `./infrastructure/observability`), `dependsOn`
`prometheus` (namespace + Prometheus Operator CRDs, for the collector's
`ServiceMonitor`) and `grafana` (the `Grafana` CR + `dashboards: "grafana"` label the two
`GrafanaDatasource` CRs attach to).

## How a request's telemetry reaches Grafana

Same shape as the local rig (see the mermaid diagram in `docs/local-observability.md`
§1), just Kubernetes-native discovery instead of Docker-socket/static-config:

```
user-management-app-api pod
  │
  ├─ GET :8080/metrics  ──scraped by──▶  kube-prometheus-stack Prometheus
  │
  ├─ stdout (JSON, logger.js)  ──tailed via K8s API by──▶  Alloy (DaemonSet)
  │                                                            │ push
  │                                                            ▼
  │                                                          Loki
  │
  └─ OTLP/HTTP :4318 (tracing.js)  ──▶  OTel Collector  ──OTLP/gRPC──▶  Tempo

Grafana ──PromQL──▶ Prometheus   ──LogQL──▶ Loki   ──TraceQL──▶ Tempo
   │
   ▼
 usermgmt-grafana.eastus2.cloudapp.azure.com
```

The app itself needs **zero changes** to point at AKS instead of the local rig — the one
env var that differs, `OTEL_EXPORTER_OTLP_ENDPOINT`, is already set in
`apps/user-management-app/k8s/base/api.yaml` to
`http://otel-collector.monitoring.svc:4318`.

## Known gaps before this is real (first-deploy checklist)

- **Alloy RBAC**: `loki.source.kubernetes` reads logs via the `pods/log` API
  subresource. The chart's default `rbac.create: true` ClusterRole is expected to
  already cover this (Alloy ships as a general-purpose "Kubernetes monitoring" agent) —
  confirm on first deploy; if logs don't show up, `kubectl logs -n monitoring
  ds/alloy` is the first thing to check, followed by `kubectl auth can-i get
  pods/log --as=system:serviceaccount:monitoring:alloy`.
- **Namespace filter**: `alloy.yaml`'s relabel rule drops `kube-system` /
  `flux-system` / etc. noise but keeps every app namespace — check log volume once
  real traffic is flowing; tighten further (e.g. keep only `monitoring` +
  `user-management-app-*`) if Loki's PVC fills up faster than expected.
- **Retention**: both Loki and Tempo are set to `168h` (7 days) on 5Gi PVCs, sized for
  a demo — revisit before this carries real production traffic.
- **No dashboards yet** for logs/traces (unlike metrics — see
  `infrastructure/grafana/json/`). Explore is the only way in today; a curated
  dashboard is a reasonable next addition once this is confirmed working.
