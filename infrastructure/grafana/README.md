# infrastructure/grafana — view nginx pod metrics

Grafana, the operator way: Flux applies these CRs, the Grafana Operator turns them into
a running Grafana. Reconciled by `clusters/dev/grafana.yaml` (dependsOn `grafana-operator`).

The `monitoring` namespace and Prometheus itself live in `../prometheus/`.

| Path | What it does |
|------|--------------|
| `operator/grafana-operator.yaml` | Installs the Grafana Operator + its CRDs. **Separate Flux Kustomization** (`clusters/dev/grafana-operator.yaml`) so the CRDs land before the CRs below — `grafana` dependsOn it. |
| `grafana.yaml` | The Grafana instance (`grafana-service:3000`) + its Prometheus datasource. |
| `json/nginx-demo.json` | The dashboard model — plain Grafana JSON, editable on its own. |
| `dashboard.yaml` | `GrafanaDashboard` CR that points at the ConfigMap key (no inline JSON). |
| `kustomization.yaml` | Bundles `json/*.json` into the `grafana-dashboards` ConfigMap (does **not** include `operator/`). |

## See it

```bash
kubectl port-forward -n monitoring svc/grafana-service 3000:3000
```
http://localhost:3000 — `admin` / `changeme123` (change `admin_password` in `grafana.yaml`).
Dashboard: **nginx-demo pods**.

**Multi-namespace:** the dashboard has a `Namespace` variable
(`label_values(kube_pod_info{pod=~"nginx-demo-.*"}, namespace)`, defaults to *All*).
Deploy the app into a new namespace and it shows up in the dropdown automatically —
panels group series by `namespace/pod`.

## Change the dashboard

Edit `json/nginx-demo.json`, commit, push — Flux regenerates the ConfigMap and the
operator re-pushes it. Or build it in the Grafana UI, export (**Share → Export → Save to
file**), and replace `json/nginx-demo.json`. Keep every panel's datasource uid
`prometheusdatasource`.

Add another dashboard: drop `json/<name>.json`, add it under `files:` in
`kustomization.yaml`, and add a `GrafanaDashboard` block to `dashboard.yaml` with
`key: <name>.json`.

Alerting (PrometheusRule + AlertmanagerConfig) is in `../alert/`.
