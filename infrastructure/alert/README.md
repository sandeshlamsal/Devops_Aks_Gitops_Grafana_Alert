# infrastructure/alert — Prometheus alerting, the operator way

Alerting as custom resources. Flux applies them; the **Prometheus Operator** (bundled in
kube-prometheus-stack) merges them into the running Prometheus and Alertmanager.

- `PrometheusRule` → Prometheus evaluates the expression, sends firing alerts to Alertmanager
- `AlertmanagerConfig` → Alertmanager routes them to a receiver (here: Gmail email)

Reconciled by the **`alert`** Flux Kustomization (path `./infrastructure/alert`),
`dependsOn` `prometheus` — Prometheus, Alertmanager and their CRDs must exist first.

---

## Files

| Path | Kind | Purpose |
|---|---|---|
| `rules/api-restarts.yaml` | `PrometheusRule` | **UserManagementAppPodRestarting** — the alert expression |
| `alertmanager-config.yaml` | `AlertmanagerConfig` | routing tree + the `email` receiver (Gmail SMTP) |
| `kustomization.yaml` | Kustomization | lists `alertmanager-config.yaml` + every file in `rules/` |

### How a rule reaches Prometheus / Alertmanager

```
rules/api-restarts.yaml  (PrometheusRule, label release: kube-prom-stack)
      │  Prometheus Operator selects it (chart's ruleSelector) and writes it into Prometheus
      ▼
Prometheus  evaluates `expr` every `interval`; when true for `for:` → alert = firing
      │  sends to Alertmanager
      ▼
Alertmanager  ◄── alertmanager-config.yaml (AlertmanagerConfig)
      │  route matches → receiver "email"
      ▼
Gmail SMTP (smtp.gmail.com:587, auth password from Secret gmail-smtp-secret)
      ▼
parasisandesh@hotmail.com
```

**Required label.** Every `PrometheusRule` must carry `labels.release: kube-prom-stack`
— that's what the chart's default rule selector matches.

**SMTP transport** lives in the receiver (`smarthost`, `authUsername`, `authPassword`).
The password is **not** in git — it's a Secret, synced from OpenBao via ESO (see
`infrastructure/secrets/`), not created by hand.

---

## The current alert

`UserManagementAppPodRestarting` (`rules/api-restarts.yaml`):

```promql
increase(kube_pod_container_status_restarts_total{container=~"api|ui", pod=~"user-management-app-.*"}[5m]) > 0
```

`for: 1m`, `severity: warning`. **Namespace-agnostic on purpose** — it matches the
`api`/`ui` containers of user-management-app by name, so `dev`, `qa`, `prod`, and any
future namespace are covered with no change here. The firing alert carries the real
`namespace` label; Alertmanager groups by `alertname` + `namespace`.

---

## How to add an alert rule

1. **Copy an existing file:**

   ```bash
   cp infrastructure/alert/rules/api-restarts.yaml infrastructure/alert/rules/api-5xx.yaml
   ```

2. **Edit it** — `metadata.name`, the `alert:` name, `expr`, `for`, `labels.severity`,
   `annotations.summary` / `.description`. Keep `metadata.namespace: monitoring` and
   `labels.release: kube-prom-stack`.

   ```yaml
   apiVersion: monitoring.coreos.com/v1
   kind: PrometheusRule
   metadata:
     name: api-5xx
     namespace: monitoring
     labels:
       release: kube-prom-stack
   spec:
     groups:
       - name: user-management-app
         rules:
           - alert: ApiHigh5xxRate
             expr: |
               sum(rate(http_request_duration_seconds_count{status=~"5.."}[5m])) by (namespace)
                 / sum(rate(http_request_duration_seconds_count[5m])) by (namespace) > 0.05
             for: 5m
             labels:
               severity: critical
             annotations:
               summary: "API 5xx rate > 5% in {{ $labels.namespace }}"
               description: "{{ $value | humanizePercentage }} of requests are 5xx over the last 5m."
   ```

3. **List it** in `kustomization.yaml`:

   ```yaml
   resources:
     - alertmanager-config.yaml
     - rules/api-restarts.yaml
     - rules/api-5xx.yaml          # <-- add
   ```

4. **Commit, push, reconcile:**

   ```bash
   git add infrastructure/alert/ && git commit -m "add ApiHigh5xxRate alert" && git push
   flux reconcile source git platform-config -n flux-system
   flux reconcile kustomization platform-config-alert -n flux-system
   ```

5. **Verify it loaded into Prometheus:**

   ```bash
   kubectl get prometheusrule -n monitoring
   kubectl port-forward -n monitoring svc/kube-prom-stack-kube-prome-prometheus 9090:9090
   curl -s http://localhost:9090/api/v1/rules \
     | jq -r '.data.groups[].rules[] | select(.type=="alerting") | "\(.name)\t\(.state)"'
   # browser: http://localhost:9090/rules
   ```

No `alertmanager-config.yaml` change is needed unless the new alert should go to a
different receiver.

---

## Routing & receivers — `alertmanager-config.yaml`

```yaml
spec:
  route:
    receiver: "email"
    groupBy: ["alertname", "namespace"]
    groupWait: 30s
    groupInterval: 5m
    repeatInterval: 1h
  receivers:
    - name: "email"
      emailConfigs:
        - to: "parasisandesh@hotmail.com"
          from: "sunwalsandesh@gmail.com"
          smarthost: "smtp.gmail.com:587"
          authUsername: "sunwalsandesh@gmail.com"
          authPassword: { name: gmail-smtp-secret, key: password }
          requireTLS: true
          sendResolved: true
```

**Add a second receiver** (e.g. Slack) and route some alerts to it:

```yaml
spec:
  route:
    receiver: "email"
    routes:
      - receiver: "slack-critical"
        matchers: [ "severity = critical" ]
        continue: true                 # also keep sending to email
  receivers:
    - name: "email"
      emailConfigs: [ ... ]
    - name: "slack-critical"
      slackConfigs:
        - apiURL: { name: slack-webhook, key: url }
          channel: "#alerts"
          sendResolved: true
```

> The chart sets `alertmanagerConfigMatcherStrategy.type: None` (see
> `infrastructure/prometheus/`), so this CR's `route` is the real root route — no
> auto-injected `namespace=` matcher.

---

## End-to-end test

### 1. Trigger a restart

```bash
kubectl exec -n user-management-app-dev-ns deploy/user-management-app-api -c api -- kill 1
# or qa/prod:
kubectl exec -n user-management-app-qa-ns  deploy/user-management-app-api -c api -- kill 1

kubectl get pods -n user-management-app-dev-ns \
  -o custom-columns='POD:.metadata.name,RESTARTS:.status.containerStatuses[*].restartCount' -w
```

### 2. Watch inactive → pending → firing

```bash
kubectl port-forward -n monitoring svc/kube-prom-stack-kube-prome-prometheus 9090:9090 &
kubectl port-forward -n monitoring svc/kube-prom-stack-kube-prome-alertmanager 9093:9093 &

# rule state
watch -n5 'curl -s http://localhost:9090/api/v1/rules \
  | jq -r ".data.groups[].rules[] | select(.name==\"UserManagementAppPodRestarting\") | .state, (.alerts[]?.labels.namespace)"'

# once firing, it shows in Alertmanager:
curl -s http://localhost:9093/api/v2/alerts \
  | jq -r '.[] | select(.labels.alertname=="UserManagementAppPodRestarting") | "\(.labels.namespace)\t\(.status.state)"'
```

Observed timeline: `inactive` → `pending` (~30s, one scrape) → `firing` (after `for: 1m`)
→ appears in Alertmanager with the real namespace → email sent.

Browser: http://localhost:9090/alerts · http://localhost:9093

### 3. Email didn't arrive?

```bash
# Alertmanager SMTP errors
kubectl logs -n monitoring alertmanager-kube-prom-stack-kube-prome-alertmanager-0 \
  -c alertmanager --tail=100 | grep -iE 'smtp|email|notify|error'

# is the receiver merged in?
curl -s http://localhost:9093/api/v2/status | jq -r '.config.original' | grep -A15 'receivers:'

# does the secret exist with key 'password'?
kubectl get secret gmail-smtp-secret -n monitoring -o jsonpath='{.data.password}' | base64 -d | wc -c
```

Common causes: secret missing / wrong key, expired Gmail app password, or the
`PrometheusRule` missing the `release: kube-prom-stack` label so it never loaded. See
the root README's [Rollback](../../README.md#9-rollback) section for how to recover a
bad alert or secret change quickly.
