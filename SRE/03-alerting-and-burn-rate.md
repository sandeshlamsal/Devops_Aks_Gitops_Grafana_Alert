# Step 3 — burn-rate alerting

## The problem plain threshold alerting has here

"Alert if the error rate is above 0.01%" sounds right — 0.01% is the exact error
budget from step 1 — but it's actually a bad alert on its own, for two opposite
reasons:

- **Too slow**: at 99.99%'s tiny budget (150 failed requests/month, from step 1), a
  real incident can spend the *entire month's* budget in minutes. An alert that only
  fires once the 30-day average crosses 0.01% won't fire until real damage is already
  done — the 30-day rolling average barely moves in the first hour of an outage.
- **Too noisy**: a genuinely brief blip (one bad minute) can spike a *short* window
  (5m) well past 0.01% without threatening the actual 30-day budget at all. Alerting
  on every 5-minute spike means alerting on noise, and noisy alerts get ignored — which
  defeats the entire point of having one.

## The fix: burn *rate*, on two windows at once

A **burn rate** of 1x means "spending the budget exactly on schedule" (all of it, used
up right at the end of the 30-day window). A burn rate of 14.4x means "spending it 14.4
times faster than that" — at that rate, 1 hour of sustained burn consumes roughly
`14.4 / (24 × 30) × 100 ≈ 2%` of the entire 30-day budget in that one hour.

The standard pattern (from Google's SRE Workbook, and what Sloth generates
automatically from step 2's `PrometheusServiceLevel`) checks **two windows at once**,
both required to agree:

```
(long-window burn rate > threshold) AND (short-window burn rate > threshold)
```

The long window (e.g. 1h) confirms the burn is *real and sustained*, not a blip. The
short window (e.g. 5m) confirms it's *still happening right now* — so the alert clears
quickly once the incident is actually over, instead of staying stuck firing for the
rest of the long window's duration.

## The four alert windows, tuned to prod's 99.99%/30-day SLO

| Severity | Long window | Short window | Burn rate threshold | Budget consumed if sustained | Routes to |
|---|---|---|---|---|---|
| **page** | 1h | 5m | 14.4x | ~2% of 30-day budget in 1h | Alertmanager → immediate page (step 5) |
| **page** | 6h | 30m | 6x | ~5% of 30-day budget in 6h | Alertmanager → immediate page |
| **ticket** | 1d | 2h | 3x | ~10% of 30-day budget in 1d | Alertmanager → ticket, not a page |
| **ticket** | 3d | 6h | 1x | ~30% of 30-day budget in 3d | Alertmanager → ticket, not a page |

This is exactly the shape Sloth generated in step 2's `pageAlert`/`ticketAlert` blocks
— two severities, each backed by two window-pairs, all four derived automatically from
one number: the `0.0001` error-budget-fraction from step 1's 99.99% target. Nobody
hand-tunes these four thresholds per SLO; that's the entire reason step 2 uses a
generator instead of hand-written `PrometheusRule`s.

## Routing through the Alertmanager that's already running

Nothing new to deploy here — these are ordinary `PrometheusRule` alerts (Sloth just
authored them), so they flow into the exact same Alertmanager already configured in
`infrastructure/alert/alertmanager-config.yaml`. Add a route matching the two new
severity labels Sloth's alerts carry:

```yaml
# infrastructure/alert/alertmanager-config.yaml — additional route, same file the
# existing UserManagementAppPodRestarting route already lives in
route:
  routes:
    - matchers: [severity = "page"]
      receiver: email        # or a dedicated pager receiver — see step 5
      repeatInterval: 15m
    - matchers: [severity = "ticket"]
      receiver: email
      repeatInterval: 4h
```

`page` alerts repeat far more often than `ticket` ones — you want to be reminded a page
is still open every 15 minutes, not every 4 hours.

## Verify it (once deployed)

```bash
kubectl get prometheusrule -n monitoring -l app=user-management-app-api -o yaml
# Prometheus UI → Alerts → look for UserManagementAppApiErrorBudgetBurn, both severities
```

To actually see one fire without waiting for a real incident: temporarily lower the
`objective` in dev's `PrometheusServiceLevel` overlay patch to something your current
dev traffic is already failing to meet (e.g. `99.9999`), reconcile, and watch the
`page`-severity alert transition `pending → firing` in the Prometheus UI within the
5-minute short window. Revert the objective back to `99.99` once you've seen it work —
this is a deliberate test trigger, not a real threshold.

Next: [`04-deployment-gating.md`](04-deployment-gating.md) — using this same burn-rate
signal to actually stop a promotion, not just notify someone.
