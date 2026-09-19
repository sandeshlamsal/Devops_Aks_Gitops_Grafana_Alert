# SRE program for user-management-app

A step-by-step build-out of core SRE practices — SLIs, SLOs, error budgets, burn-rate
alerting, error-budget-gated deployments, and incident management — grounded entirely
in the app and platform already in this repo (`apps/user-management-app`, the existing
Prometheus/Grafana/Alertmanager stack, the existing `promote-qa`/`promote-prod`
pipeline). Nothing here introduces a parallel monitoring stack; every step extends
something already running.

**Status: design + implementation guide, not yet deployed.** Every file below has real,
copy-pasteable YAML/code, grounded in this app's actual metric names and file
structure — but none of it has been applied to a live cluster yet (there isn't one
right now — see the root README's teardown/stand-up story). Treat each file's examples
the way `infrastructure/observability/README.md` treats its own: correct on paper,
first-deploy-checklist still to come.

## Why this order

Each step depends on the one before it — you cannot gate a deployment on an error
budget that doesn't exist yet, and you cannot compute an error budget without an SLI to
measure first. Read and build in order. **New to DevOps or SRE? Start at step 0** — it
explains every concept the later files assume you already know (containers,
Kubernetes, GitOps, operators/CRDs, CI/CD, Prometheus, PromQL, Grafana, Alertmanager)
from zero, grounded in this exact repo throughout. If you already know that world,
skip straight to step 1.

| Step | File | What it adds |
|---|---|---|
| 0 | [`00-devops-and-sre-basics.md`](00-devops-and-sre-basics.md) | Everything steps 1–6 assume you already know — containers, Kubernetes, GitOps, operators/CRDs, CI/CD, and the observability stack (Prometheus/PromQL/Grafana/Alertmanager), all explained from zero and grounded in this repo |
| 1 | [`01-slis-and-slos.md`](01-slis-and-slos.md) | What to measure (SLIs), the target (SLOs), and the error-budget math — concepts + the concrete numbers chosen for this app |
| 2 | [`02-implementation-sloth.md`](02-implementation-sloth.md) | Turn the SLOs from step 1 into real Prometheus recording rules, using **Sloth** (open-source SLO operator) instead of hand-written PromQL |
| 3 | [`03-alerting-and-burn-rate.md`](03-alerting-and-burn-rate.md) | Get paged *before* the budget is fully gone — multi-window, multi-burn-rate alerting, routed through the Alertmanager that's already running |
| 4 | [`04-deployment-gating.md`](04-deployment-gating.md) | The circuit breaker: `promote-qa`/`promote-prod` refuse to promote while an environment's error budget is exhausted |
| 5 | [`05-incident-management.md`](05-incident-management.md) | What happens when a burn-rate alert actually fires — auto-ticketing + a postmortem format |
| 6 | [`06-dashboard.md`](06-dashboard.md) | See it all in Grafana — the error-budget burn-down panel |

## The one new component

Everything here reuses what's already running (Prometheus, Alertmanager, Grafana, the
`PrometheusRule`/`GrafanaDashboard` operator-CRD pattern this whole repo already
follows, the GitHub Actions promotion pipeline) with one addition: **[Sloth](https://sloth.dev)**,
an open-source (Apache-2.0) SLO tool with a Kubernetes operator mode. It generates the
recording-rule and burn-rate-alert PromQL from a small declarative `SLO` spec instead
of you hand-writing it — the math in step 1 is worth understanding, but not worth
maintaining by hand across every environment and every SLO you'll ever add.
