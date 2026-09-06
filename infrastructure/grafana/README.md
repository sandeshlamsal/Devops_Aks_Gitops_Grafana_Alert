# infrastructure/grafana — dashboards, the operator way

Our own Grafana, run **inside the cluster** and driven entirely by custom resources.
Flux applies the CRs in this folder; the **Grafana Operator** turns them into a running
Grafana and pushes dashboards/datasources into it over Grafana's HTTP API.

> This is **not** Azure Managed Grafana (the "Dashboards with Grafana" blade in the AKS
> portal). That is a separate product fed by Azure Monitor managed Prometheus. This repo
> runs its own Grafana + Prometheus; our dashboards only appear here.

Reconciled by two Flux Kustomizations:

| Kustomization | Path | Applies | Depends on |
|---|---|---|---|
| `grafana-operator` | `infrastructure/grafana/operator` | the operator Helm install (+ its CRDs) | `prometheus` |
| `grafana` | `infrastructure/grafana` | `Grafana`, `GrafanaDatasource`, `GrafanaFolder`, `GrafanaDashboard` | `grafana-operator` |

**Why two.** Flux rejects a whole Kustomization if it contains a CR whose CRD isn't
registered yet. If the operator install and the `Grafana*` CRs were in one Kustomization,
the first apply would fail (`no matches for kind "GrafanaDashboard"`) and the operator
would never install. Splitting it — operator in its own Kustomization that `grafana`
`dependsOn` — guarantees the CRDs exist first.

---

## Files

| Path | Kind | Purpose |
|---|---|---|
| `operator/grafana-operator.yaml` | `HelmRepository` + `HelmRelease` | installs grafana-operator from `oci://ghcr.io/grafana/helm-charts` |
| `operator/kustomization.yaml` | Kustomization | the operator install as its own unit |
| `grafana.yaml` | `Grafana` + `GrafanaDatasource` | the Grafana instance (Deployment + `grafana-service:3000`) and its Prometheus datasource (uid `prometheusdatasource`) |
| `folder.yaml` | `GrafanaFolder` | the **"Custom Application Dashboards"** folder |
| `json/nginx-demo.json` | — | the **Nginx Dashboard** model (plain Grafana JSON) |
| `dashboard.yaml` | `GrafanaDashboard` | references the ConfigMap key + files the dashboard in the folder |
| `kustomization.yaml` | Kustomization | `configMapGenerator` bundles `json/*.json` into the `grafana-dashboards` ConfigMap; applies the CRs above |

### The join key

Every `Grafana*` CR carries:

```yaml
spec:
  instanceSelector:
    matchLabels:
      dashboards: "grafana"
```

which matches the label on the `Grafana` CR in `grafana.yaml`. That's how the operator
knows which Grafana to push a datasource / folder / dashboard into. Keep that label
consistent or CRs show `NO MATCHING INSTANCES`.

### How a dashboard JSON reaches Grafana

```
json/nginx-demo.json                     (plain JSON, you edit this)
      │  kustomization.yaml → configMapGenerator (files:), disableNameSuffixHash
      ▼
ConfigMap monitoring/grafana-dashboards  (key: nginx-demo.json)
      │  dashboard.yaml → GrafanaDashboard { configMapRef: {name, key}, folderRef }
      ▼
Grafana Operator  → PUTs the dashboard into Grafana, in the "Custom Application Dashboards" folder
```

`resyncPeriod: 5m` on the `GrafanaDashboard` means a change made in the Grafana UI is
overwritten from git within 5 minutes — **git is the source of truth**.

---

## Configure

### Admin credentials — `grafana.yaml`

```yaml
spec:
  config:
    security:
      admin_user: admin
      admin_password: changeme123      # change this
```

For a real password use an env var from a Secret instead:

```yaml
spec:
  config:
    security:
      admin_user: admin
      admin_password: $__env{GF_SECURITY_ADMIN_PASSWORD}
  deployment:
    spec:
      template:
        spec:
          containers:
            - name: grafana
              env:
                - name: GF_SECURITY_ADMIN_PASSWORD
                  valueFrom:
                    secretKeyRef: { name: grafana-admin, key: password }
```

(then `kubectl create secret generic grafana-admin -n monitoring --from-literal=password=...`)

### Datasource — `grafana.yaml`

Points at the in-cluster Prometheus:

```yaml
url: http://kube-prom-stack-kube-prome-prometheus.monitoring.svc:9090
uid: prometheusdatasource      # referenced by every panel — keep stable
```

Add another datasource (Loki, a second Prometheus, …) by adding another
`GrafanaDatasource` CR with the same `instanceSelector`.

### Exposing Grafana

`grafana-service` is `ClusterIP`. Options to give the team a URL:

```bash
# quick, local
kubectl port-forward -n monitoring svc/grafana-service 3000:3000
```

For a shared URL, add to `grafana.yaml`:

```yaml
spec:
  service:
    spec:
      type: LoadBalancer        # or keep ClusterIP and add spec.ingress below
  # ingress:
  #   spec:
  #     ingressClassName: nginx
  #     rules:
  #       - host: grafana.example.com
  #         http: { paths: [{ path: /, pathType: Prefix, backend: { service: { name: grafana-service, port: { number: 3000 } } } }] }
```

⚠️ A public `LoadBalancer` with `admin/changeme123` is wide open — change the password
and/or put auth in front first.

---

## How to add a new dashboard

1. **Get the JSON.** In Grafana build the dashboard, then **Share → Export → Save to
   file** (toggle *Export for sharing externally* off). Or grab one from grafana.com.
   Make every panel's datasource `{"type": "prometheus", "uid": "prometheusdatasource"}`.

2. **Drop the file** in `json/`:

   ```bash
   cp ~/Downloads/my-service.json infrastructure/grafana/json/my-service.json
   ```

3. **List it** in `kustomization.yaml` under `configMapGenerator[0].files`:

   ```yaml
   configMapGenerator:
     - name: grafana-dashboards
       namespace: monitoring
       files:
         - json/nginx-demo.json
         - json/my-service.json        # <-- add
   ```

4. **Add a `GrafanaDashboard` CR** — append to `dashboard.yaml` (it's a multi-doc file):

   ```yaml
   ---
   apiVersion: grafana.integreatly.org/v1beta1
   kind: GrafanaDashboard
   metadata:
     name: my-service
     namespace: monitoring
   spec:
     instanceSelector:
       matchLabels:
         dashboards: "grafana"
     folderRef: custom-application-dashboards
     resyncPeriod: 5m
     configMapRef:
       name: grafana-dashboards
       key: my-service.json
   ```

5. **Commit, push, reconcile:**

   ```bash
   git add infrastructure/grafana/ && git commit -m "add my-service dashboard" && git push
   flux reconcile source git nginx-demo-config -n flux-system
   flux reconcile kustomization nginx-demo-config-grafana -n flux-system
   ```

6. **Verify:**

   ```bash
   kubectl get grafanadashboard -n monitoring
   kubectl describe grafanadashboard my-service -n monitoring   # status.conditions → applied
   ```

   In Grafana: **Dashboards → Custom Application Dashboards → …**

### Add a new folder

New `GrafanaFolder` CR (own file or appended to `folder.yaml`), list it in
`kustomization.yaml` `resources:`, and set `folderRef: <its metadata.name>` on the
dashboards you want in it.

```yaml
apiVersion: grafana.integreatly.org/v1beta1
kind: GrafanaFolder
metadata:
  name: platform-dashboards
  namespace: monitoring
spec:
  instanceSelector: { matchLabels: { dashboards: "grafana" } }
  title: "Platform Dashboards"
```

---

## The Nginx Dashboard

`json/nginx-demo.json`, uid `nginx-demo`, in folder **Custom Application Dashboards**.

- **Namespace** template variable (multi-value, defaults to *All*):
  `label_values(kube_pod_info{pod=~"nginx-demo-.*"}, namespace)` — every namespace running
  the app appears automatically (`nginx-dev-app-ns`, `nginx-qa-app-ns`, …).
- Panels (all `by (namespace, pod)`):
  - **CPU usage (cores) per pod** — `rate(container_cpu_usage_seconds_total{…}[5m])`
  - **Memory working set (bytes) per pod** — `container_memory_working_set_bytes{…}`
  - **Container restarts per pod** — `kube_pod_container_status_restarts_total{…}`

To change it: edit `json/nginx-demo.json`, commit, push, reconcile (as above). The
operator re-pushes within `resyncPeriod`.

---

## Test / inspect

```bash
kubectl port-forward -n monitoring svc/grafana-service 3000:3000 &

curl -s -u admin:changeme123 http://localhost:3000/api/health
curl -s -u admin:changeme123 http://localhost:3000/api/datasources
curl -s -u admin:changeme123 'http://localhost:3000/api/datasources/uid/prometheusdatasource/health'
curl -s -u admin:changeme123 'http://localhost:3000/api/search?type=dash-db'      # lists dashboards + their folder
curl -s -u admin:changeme123 'http://localhost:3000/api/folders'                  # lists folders

# values the Namespace variable will show:
curl -s -u admin:changeme123 \
  'http://localhost:3000/api/datasources/uid/prometheusdatasource/resources/api/v1/label/namespace/values?match%5B%5D=kube_pod_info%7Bpod%3D~%22nginx-demo-.%2A%22%7D'

# operator logs
kubectl logs -n monitoring deploy/grafana-operator --tail=100
```
