# apps/ — application workloads

One app, **user-management-app**, deployed to `dev` / `qa` / `prod` namespaces by Flux +
Kustomize (`base/` + `overlays/<env>/`). Infrastructure (Prometheus, Grafana, alerting,
secrets, the CNPG operator, Flux Image Automation) is in
[`infrastructure/`](../infrastructure/); the Flux Kustomizations that tie repo paths to
the cluster are in [`clusters/dev/`](../clusters/dev/).

| App | What it is | Namespaces | Flux Kustomizations |
|---|---|---|---|
| [`user-management-app/`](user-management-app/) | 3 microservices — React UI + Node API + Postgres (CloudNativePG). Log in → list users. Has unit/integration tests, DB migrations, fixtures, a per-namespace reset job, and a local Docker Desktop test rig. | `user-management-app-dev-ns`, `-qa-ns`, `-prod-ns` | `user-management-app-dev`, `-qa`, `-prod` (+ `cnpg-operator`) |

## The pattern

```
apps/user-management-app/
  api/, ui/                  service source + Dockerfile + tests
  docker-compose.yml         local test rig (see the app README)
  k8s/base/                  environment-agnostic manifests (+ kustomization.yaml)
  k8s/overlays/<env>/
    namespace.yaml           creates the env namespace
    kustomization.yaml       namespace: <ns>, resources: [namespace.yaml, ../../base],
                             images: (ACR path + tag), patches: [patch.yaml]
    patch.yaml               per-env values (replicas, APP_ENV, DNS label, …)
```

- **Images** live in `sanaksregistry.azurecr.io`, built by CI (`.github/workflows/ci.yml`,
  `release.yml`) — see the app README's CI/CD section. Overlays pin the tag via the
  `images:` transformer; the dev overlay additionally carries `$imagepolicy` marker
  comments that Flux Image Automation rewrites (`infrastructure/flux-image-automation/`).
- **ServiceMonitors** ship with the app; Prometheus auto-discovers them
  (`serviceMonitorSelector: {}` in `infrastructure/prometheus/`), so metrics work in any
  namespace with no infra change.
- **Secrets** come from OpenBao via `ExternalSecret` CRs (never in git). CNPG generates
  its own DB credentials Secret.
- **All three Flux Kustomizations ship `spec.suspend: true`** — nothing deploys until a
  `promote-dev` / `promote-qa` / `promote-prod` GitHub Actions run arms it (root README §6).
- **A new env** (e.g. `staging`) = copy an overlay, change the namespace, add one Flux
  Kustomization (`suspend: true`) + one `promote-staging.yml` workflow. Nothing in
  `infrastructure/` changes.

## Details

See [`user-management-app/README.md`](user-management-app/README.md): the 3 services,
the API routes, CloudNativePG, migrations/fixtures/reset, unit tests, local Docker
Desktop testing, image builds, and the Flux/OpenBao wiring. The root README covers the
CI/CD pipeline, promotion model, rollback, and multi-cloud roadmap end to end.
