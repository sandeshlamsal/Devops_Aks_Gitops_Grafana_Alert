# Step 2 — turning the SLOs into real Prometheus rules, with Sloth

## Why a tool instead of hand-written PromQL

Step 1's SLI/SLO math is simple for one SLO. It stops being simple the moment you have
2 SLIs × 3 environments (6 SLOs) each needing: a multi-window recording rule set (5m,
30m, 1h, 6h, 1d, 3d — six windows just for *one* SLO, to make step 3's burn-rate
alerting both fast *and* accurate), plus the burn-rate alert thresholds themselves,
correctly derived from the SLO target and window size. Hand-writing and maintaining
that across 6 SLOs is exactly the kind of repetitive, error-prone YAML this whole
repo's "operator + CRD + GitOps" pattern exists to avoid — so apply the same pattern
here: **[Sloth](https://sloth.dev)** is a Kubernetes operator that watches a small
`PrometheusServiceLevel` custom resource and generates the full `PrometheusRule` (every
recording rule, every burn-rate alert) for you.

## Install it (same pattern as every other operator in this repo)

```yaml
# infrastructure/sloth/helmrepository.yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: HelmRepository
metadata:
  name: sloth
  namespace: monitoring
spec:
  interval: 1h
  url: https://slok.github.io/sloth
```

```yaml
# infrastructure/sloth/sloth.yaml
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: sloth
  namespace: monitoring
spec:
  interval: 30m
  chart:
    spec:
      chart: sloth
      version: ">=0.9.0 <1.0.0"
      sourceRef:
        kind: HelmRepository
        name: sloth
        namespace: monitoring
  values:
    commonLabels:
      # matches the label kube-prometheus-stack's Prometheus already selects
      # PrometheusRules on — see infrastructure/alert/README.md
      release: kube-prom-stack
```

```yaml
# infrastructure/sloth/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - helmrepository.yaml
  - sloth.yaml
```

```yaml
# clusters/dev/sloth.yaml — dependsOn prometheus: needs the Prometheus Operator's
# PrometheusRule CRD registered before Sloth's controller can create any
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: sloth
  namespace: flux-system
spec:
  interval: 10m
  path: ./infrastructure/sloth
  prune: true
  dependsOn:
    - name: prometheus
  sourceRef:
    kind: GitRepository
    name: flux-system
  targetNamespace: monitoring
```

## The SLO, as a custom resource

This is the piece that replaces all the hand-written PromQL from step 1. One
`PrometheusServiceLevel` per SLO, per environment — this is prod's availability SLO:

```yaml
# apps/user-management-app/k8s/base/slo-availability.yaml
apiVersion: sloth.slok.dev/v1
kind: PrometheusServiceLevel
metadata:
  name: user-management-app-api-availability
  labels:
    # picked up by kube-prometheus-stack the same way every other PrometheusRule
    # in this repo already is — see infrastructure/alert/README.md
    release: kube-prom-stack
spec:
  service: "user-management-app-api"
  labels:
    app: user-management-app-api
  slos:
    - name: "availability"
      objective: 99.99   # the base target from step 1 — same number in every environment, only prod's is enforced
      description: "Proportion of requests that do not return 5xx"
      sli:
        events:
          errorQuery: sum(rate(http_request_duration_seconds_count{status=~"5..",namespace="$namespace"}[{{.window}}]))
          totalQuery: sum(rate(http_request_duration_seconds_count{namespace="$namespace"}[{{.window}}]))
      alerting:
        name: UserManagementAppApiErrorBudgetBurn
        labels:
          service: user-management-app-api
        annotations:
          summary: "user-management-app-api is burning its error budget too fast"
        pageAlert:
          labels:
            severity: page       # fast burn — routes to immediate paging, see step 3
        ticketAlert:
          labels:
            severity: ticket     # slow burn — routes to a lower-urgency notification
```

`$namespace` gets substituted per overlay (`user-management-app-dev-ns` /
`-qa-ns` / `-prod-ns`), same as every other per-environment value in this app —
patch it in `k8s/overlays/<env>/patch.yaml`, same shape as the existing `APP_ENV`
patches:

```yaml
# k8s/overlays/prod/patch.yaml — additional patch document
apiVersion: sloth.slok.dev/v1
kind: PrometheusServiceLevel
metadata:
  name: user-management-app-api-availability
spec:
  slos:
    - name: "availability"
      # objective stays 99.99 everywhere (step 1's base) — only the namespace changes
      # per overlay; only prod's copy of this SLO actually gates anything (step 4)
      sli:
        events:
          errorQuery: sum(rate(http_request_duration_seconds_count{status=~"5..",namespace="user-management-app-prod-ns"}[{{.window}}]))
          totalQuery: sum(rate(http_request_duration_seconds_count{namespace="user-management-app-prod-ns"}[{{.window}}]))
```

(qa/dev overlays repeat this with their own namespace in both queries — same
`objective: 99.99`, per step 1's table.)

## What this actually generates

Once Sloth's controller reconciles that `PrometheusServiceLevel`, it creates a
`PrometheusRule` on the cluster containing (abbreviated — Sloth generates the full set,
this is illustrative of the shape, not a complete listing):

```yaml
# generated by Sloth — you never write this by hand, shown here so you know what
# "it worked" looks like when you check `kubectl get prometheusrule -n monitoring`
groups:
  - name: sloth-slo-sli-recordings-user-management-app-api-availability
    rules:
      - record: slo:sli_error:ratio_rate5m
        expr: |
          sum(rate(http_request_duration_seconds_count{status=~"5..",namespace="user-management-app-prod-ns"}[5m]))
          /
          sum(rate(http_request_duration_seconds_count{namespace="user-management-app-prod-ns"}[5m]))
      # ...same shape for 30m, 1h, 6h, 1d, 3d windows
  - name: sloth-slo-alerts-user-management-app-api-availability
    rules:
      - alert: UserManagementAppApiErrorBudgetBurn
        expr: |
          (slo:sli_error:ratio_rate1h > (14.4 * 0.0001) and slo:sli_error:ratio_rate5m > (14.4 * 0.0001))
          or
          (slo:sli_error:ratio_rate6h > (6 * 0.0001) and slo:sli_error:ratio_rate30m > (6 * 0.0001))
        labels:
          severity: page
        annotations:
          summary: "user-management-app-api is burning its error budget too fast"
```

That `14.4 *` / `6 *` multiplier is the burn-rate math — covered next.

## Verify it worked (once deployed)

```bash
kubectl get prometheusservicelevel -n user-management-app-prod-ns
kubectl get prometheusrule -n monitoring -l app=user-management-app-api
# in Grafana Explore, against Prometheus: slo:sli_error:ratio_rate5m
```

Next: [`03-alerting-and-burn-rate.md`](03-alerting-and-burn-rate.md) — what those
multipliers mean, and why there are two conditions ANDed together in every alert.
