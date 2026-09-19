# Step 5 — incident management: auto-ticketing + postmortems

**Status: implemented and live-verified** (2026-09-19) — `.github/workflows/slo-incident-ticketing.yml`
and `SRE/postmortem-template.md` are real, not just design. Two pieces, both reusing
what this repo already has rather than adding a dedicated incident tool
(PagerDuty/Opsgenie/etc. are the real answer at real scale — genuinely overkill for
this app's current size, and worth naming as the honest "what you'd actually use in
production" alternative rather than pretending GitHub Issues scales indefinitely).

## Auto-open a GitHub Issue when a page alert fires

No new long-running infrastructure — a scheduled GitHub Action polling Alertmanager
every 5 minutes (`*/5 * * * *`, matching step 3's shortest alert window), consistent
with how every other cross-cutting check in this repo already runs (CI on push,
promotion checks in workflow jobs) rather than standing up a webhook receiver that has
to be hosted somewhere and kept alive. Reaches the cluster the same way
`promote-*.yml` does — OIDC login, `azure/aks-set-context`, then `kubectl port-forward`
to Alertmanager instead of patching a Kustomization.

See the real file: [`.github/workflows/slo-incident-ticketing.yml`](../.github/workflows/slo-incident-ticketing.yml).

Design choices worth calling out:

- **One issue per distinct incident, not one issue total.** It groups firing
  `severity=page` alerts by `(alertname, namespace)` — so if dev and prod both have
  the same alert firing, they get two separate tickets, not one that conflates two
  different environments. (Deliberately not scoped to prod-only, unlike step 4's
  gate — an incident is worth tracking wherever it happens.)
- **Idempotent via a hidden marker, not a label per incident.** Rather than creating a
  new GitHub label per alert+namespace pair (unbounded label growth), each issue body
  gets an HTML comment `<!-- incident-key: <alertname>:<namespace> -->` and the check
  greps open `incident`-labeled issues for that exact key before creating a new one.
- **Never auto-closes.** Closing an incident ticket is a judgment call a person makes
  after confirming things are actually fixed, not something a burn-rate metric
  dropping below a threshold should decide on its own.
- **Doesn't claim the deployment gate blocked anything.** [`SRE/04-deployment-gating.md`](04-deployment-gating.md)'s
  `promote-prod.yml` gate is still documentation-only, not wired in — the issue body
  doesn't assert a promotion was refused, since that isn't true yet.

**Live-verified:** triggered via `workflow_dispatch` against the real dev stand-up
while `UserManagementAppApiAvailabilityBudgetBurn` (severity=page) was actually
firing (from the synthetic error traffic in [SRE/02](02-implementation-sloth.md)'s
verification) — it opened exactly one issue, correctly keyed to
`UserManagementAppApiAvailabilityBudgetBurn:user-management-app-dev-ns`. A second run
while the same incident was still firing did **not** open a duplicate.

## The postmortem format

This repo already has a working postmortem log — `PR-README.md`, "the record of every
real problem hit deploying this repo to a live AKS cluster." The auto-opened issue
body includes the full template inline (from
[`SRE/postmortem-template.md`](postmortem-template.md)) — fill it in once mitigated,
then copy the filled-in version into `PR-README.md`, same as every other real problem
this project has hit, so incidents live alongside everything else rather than in a
separate, easy-to-forget place.

The template's last question matters most: **did the deployment gate (step 4) block a
bad promotion during this incident, or was the incident from something the gate can't
see** (a dependency outage, a bad node, etc.)? The gate only stops *new* deployments —
it does nothing for an incident already in progress from an unrelated cause. Track
whether the gate was actually relevant each time, so the SLO program's real value gets
evaluated honestly over time, not assumed.

Next: [`06-dashboard.md`](06-dashboard.md) — seeing the error budget and its burn-down
in Grafana, tying the whole program together visually.
