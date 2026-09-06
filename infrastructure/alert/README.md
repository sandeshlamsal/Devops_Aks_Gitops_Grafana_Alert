# infrastructure/alert — Prometheus alerting

Alerting the Prometheus Operator way: Flux applies these CRs, the Prometheus Operator
loads them into Prometheus and Alertmanager. Reconciled by `clusters/dev/alert.yaml`
(dependsOn `prometheus`).

```
alertmanager-config.yaml   AlertmanagerConfig — routing + email receiver (shared)
rules/                      one PrometheusRule file per alert   <-- add rules here
  nginx-restarts.yaml       NginxPodRestarting — fires when an nginx-demo pod restarts
kustomization.yaml
```

| CR | Purpose |
|----|---------|
| `PrometheusRule` (`rules/*.yaml`) | The alert expression. Needs label `release: kube-prom-stack`. |
| `AlertmanagerConfig` (`alertmanager-config.yaml`) | Route every alert to the `email` receiver → `parasisandesh@hotmail.com`, via Gmail SMTP. |

`NginxPodRestarting` fires when
`increase(kube_pod_container_status_restarts_total{pod=~"nginx-demo.*"}[5m]) > 0` for 1m.
The Gmail app password comes from the `gmail-smtp-secret` Secret (see the repo root README).

## Test it

```bash
kubectl exec -n default deploy/nginx-demo -- sh -c "kill 1"     # restarts one pod
kubectl port-forward -n monitoring svc/kube-prom-stack-kube-prome-alertmanager 9093:9093
```
`NginxPodRestarting` shows Pending → Firing at http://localhost:9093 within ~1–2 min,
then an email is sent. If none arrives:
```bash
kubectl logs -n monitoring alertmanager-kube-prom-stack-kube-prome-alertmanager-0 -c alertmanager --tail=50
```

## Add a rule

1. `cp rules/nginx-restarts.yaml rules/<name>.yaml`
2. Edit `metadata.name`, the `alert:` name, `expr`, `for`, `severity`, and annotations.
   Keep the `release: kube-prom-stack` label.
3. Add `- rules/<name>.yaml` to `kustomization.yaml`.
4. Commit and push. No `alertmanager-config.yaml` change needed unless it routes elsewhere.
