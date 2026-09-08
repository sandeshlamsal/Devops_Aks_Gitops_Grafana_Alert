# apps/ — application workloads

Two independent apps, each deployed to its own `dev` + `qa` namespaces by Flux +
Kustomize (`base/` + `overlays/<env>/`). Infrastructure (Prometheus, Grafana, alerting,
secrets, the CNPG operator) is in [`infrastructure/`](../infrastructure/); the Flux
Kustomizations that tie repo paths to the cluster are in [`clusters/dev/`](../clusters/dev/).

| App | What it is | Namespaces | Flux Kustomizations |
|---|---|---|---|
| [`nginx-demo/`](nginx-demo/) | nginx + a `nginx-prometheus-exporter` sidecar. The subject of the `NginxPodRestarting` alert and the Grafana **Nginx Dashboard**. | `nginx-dev-app-ns` (2 replicas), `nginx-qa-app-ns` (1) | `apps`, `apps-qa` |
| [`user-login/`](user-login/) | 3 microservices — React UI + Node API + Postgres (CloudNativePG). Log in → list users. Has DB migrations, fixtures, and a per-namespace reset job. | `userlogin-dev-ns`, `userlogin-qa-ns` | `user-login-dev`, `user-login-qa` (+ `cnpg-operator`) |

## The pattern (both apps)

```
apps/<app>/
  base/                      environment-agnostic manifests (+ kustomization.yaml)
  overlays/<env>/
    namespace.yaml           creates the env namespace
    kustomization.yaml       namespace: <ns>, resources: [namespace.yaml, ../../base],
                             images: (ACR path + tag), patches: [patch.yaml]
    patch.yaml               per-env values (replicas, APP_ENV, DNS label, …)
```

- **Images** live in `sanaksregistry.azurecr.io`, built with `az acr build` (see each
  app's README). Overlays pin the tag via the `images:` transformer.
- **ServiceMonitors** ship with the app; Prometheus auto-discovers them
  (`serviceMonitorSelector: {}` in `infrastructure/prometheus/`), so metrics work in any
  namespace with no infra change.
- **Secrets** come from OpenBao via `ExternalSecret` CRs (never in git). CNPG generates
  its own DB credentials Secret.
- **A new env** (e.g. `staging`) = copy an overlay, change the namespace, add one Flux
  Kustomization. Nothing in `infrastructure/` changes.

## Per-app details

- **nginx-demo** — [`nginx-demo/`](nginx-demo/) has no README of its own; it's covered in
  the repo root README (§6 alert test, §8 multi-env) and
  [`infrastructure/alert/README.md`](../infrastructure/alert/README.md).
- **user-login** — [`user-login/README.md`](user-login/README.md): the 3 services, the
  API routes, CloudNativePG, migrations/fixtures, the reset job, image builds, and the
  Flux/OpenBao wiring.
