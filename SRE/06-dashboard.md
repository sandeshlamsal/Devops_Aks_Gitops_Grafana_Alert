# Step 6 — seeing it in Grafana

Same operator/CRD pattern the existing "User Management App" dashboard already uses
(`infrastructure/grafana/dashboard.yaml`) — a `GrafanaDashboard` CR pointing at a JSON
model bundled into a ConfigMap, filed into the same "Custom Application Dashboards"
folder. Nothing new to learn here if you've already read that file.

## Wiring

```yaml
# infrastructure/grafana/dashboard-slo.yaml
apiVersion: grafana.integreatly.org/v1beta1
kind: GrafanaDashboard
metadata:
  name: user-management-app-slo
  namespace: monitoring
spec:
  instanceSelector:
    matchLabels:
      dashboards: "grafana"
  folderRef: custom-application-dashboards
  resyncPeriod: 1m
  configMapRef:
    name: grafana-dashboards
    key: user-management-app-slo.json
```

```yaml
# infrastructure/grafana/kustomization.yaml — add the new dashboard alongside the
# existing one (both files, both keys)
configMapGenerator:
  - name: grafana-dashboards
    namespace: monitoring
    files:
      - json/user-management-app.json
      - json/user-management-app-slo.json   # new
resources:
  - grafana.yaml
  - folder.yaml
  - dashboard.yaml
  - dashboard-slo.yaml   # new
```

## What's on it

Three panels, each backed by a recording rule Sloth (step 2) already generates — none
of these queries need to be written by hand, they're the same `slo:*` rules referenced
in steps 2 and 3:

| Panel | Query | Why |
|---|---|---|
| **Error budget remaining** (gauge, 0–100%) | `slo:error_budget:ratio{service="user-management-app-api"}` | The single most important number on the whole dashboard — this is literally what step 4's gate checks |
| **Burn-down over the 30-day window** (time series) | `1 - slo:error_budget:ratio{service="user-management-app-api"}` | Budget *consumed* over time — a steep drop is an incident, a flat line is a quiet month |
| **Current burn rate, per window** (time series, one line per window) | `slo:sli_error:ratio_rate5m`, `slo:sli_error:ratio_rate1h`, `slo:sli_error:ratio_rate6h` | Lets you see *which* of step 3's alert windows is closest to tripping, before it does |

A representative panel definition (the burn-down gauge — the rest follow the same
shape, differing only in the query and panel type):

```json
{
  "type": "gauge",
  "title": "Error budget remaining — prod",
  "targets": [
    {
      "expr": "slo:error_budget:ratio{service=\"user-management-app-api\", namespace=\"user-management-app-prod-ns\"} * 100",
      "legendFormat": "budget remaining"
    }
  ],
  "fieldConfig": {
    "defaults": {
      "unit": "percent",
      "min": 0,
      "max": 100,
      "thresholds": {
        "steps": [
          { "color": "red", "value": 0 },
          { "color": "yellow", "value": 20 },
          { "color": "green", "value": 50 }
        ]
      }
    }
  }
}
```

Repeat the whole dashboard's variable-driven version (a `namespace` template variable,
same as the existing dashboard's Namespace picker) if you want one dashboard that
switches between dev/qa/prod rather than three separate ones — the existing
`json/user-management-app.json` already has that picker; copy the pattern rather than
re-inventing it.

## Verify it (once deployed)

```bash
kubectl describe grafanadashboard user-management-app-slo -n monitoring
# status.conditions should show synced — same failure mode as the existing dashboard
# if it doesn't: NO MATCHING INSTANCES means the instanceSelector label doesn't match
# the Grafana CR (see the root README's Troubleshooting table, same entry applies)
```

Then in Grafana: **Dashboards → Custom Application Dashboards → User Management App
SLO**.

---

## That's the whole program, end to end

1. **[SLIs & SLOs](01-slis-and-slos.md)** — what to measure, and the 99.99% target
2. **[Sloth](02-implementation-sloth.md)** — SLO target → real Prometheus rules, generated not hand-written
3. **[Burn-rate alerting](03-alerting-and-burn-rate.md)** — fast + accurate, tuned to the SLO from step 1
4. **[Deployment gating](04-deployment-gating.md)** — the actual circuit breaker in `promote-prod.yml`
5. **[Incident management](05-incident-management.md)** — auto-ticketing + a postmortem format
6. **Dashboard** (this file) — see all of the above in one place

Every step reused something already in this repo (Prometheus, Alertmanager, Grafana,
the operator/CRD pattern, the GitHub Actions promotion pipeline) plus exactly one new
component (Sloth). Nothing here has been applied to a live cluster yet — see each
file's YAML as the starting point for the next real stand-up's first-deploy checklist,
the same way `infrastructure/observability/README.md` treats its own.
