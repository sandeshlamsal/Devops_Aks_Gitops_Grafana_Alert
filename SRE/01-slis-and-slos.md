# Step 1 — SLIs, SLOs, and the error-budget math

## What these words actually mean

- **SLI (Service Level Indicator)** — a number you can measure, right now, from real
  traffic. "What fraction of requests succeeded" is an SLI. Not a target, not a
  promise — just a measurement.
- **SLO (Service Level Objective)** — a target for an SLI over a time window. "99.5%
  of requests succeed, measured over a rolling 30 days" is an SLO.
- **Error budget** — the inverse of the SLO, turned into a spendable allowance. A 99.5%
  SLO means a **0.5% error budget** — you're *allowed* 0.5% of requests to fail over
  that window before you've broken your promise. The budget is the whole point: it
  turns "no downtime, ever" (impossible, and not what anyone actually needs) into "a
  known, spendable amount of unreliability," which is what makes step 4's deployment
  gate meaningful — there's an actual number to gate on.

## Step 0 — fix the metric before you build anything on top of it

`api/src/server.js` already has an SLI-shaped metric:

```js
const httpHist = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration",
  labelNames: ["method", "route", "status"],
});
```

But look closer: **no `buckets` array is set**, so it falls back to `prom-client`'s
defaults — `0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10` seconds. If your
latency SLO target is going to be "under 300ms," there is no `le="0.3"` bucket to query
— the nearest ones are `0.25` and `0.5`, neither of which is your actual threshold. This
is the single most common real-world way people accidentally ship a latency SLO they
can't actually compute: the histogram just doesn't have a boundary at the number they
promised. Fix it first:

```js
const httpHist = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration",
  labelNames: ["method", "route", "status"],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 1, 2.5, 5],  // 0.3 = the SLO threshold, on purpose
});
```

Any latency SLO you define below assumes this change has shipped — everything after
this point in the doc is unreachable without it.

## The two SLIs for `user-management-app-api`

Kept to two on purpose — this is a small app, and a first SLO program with ten SLIs is
a program nobody maintains. Both are computable from the one histogram metric above,
per environment (the `env` label already exists via `APP_ENV` — confirm your recording
rules group by it, or you'll average dev's traffic into prod's number).

| SLI | What it measures | PromQL (last 5 minutes, one environment) |
|---|---|---|
| **Availability** | fraction of requests that did *not* return 5xx | `sum(rate(http_request_duration_seconds_count{status!~"5..",env="prod"}[5m])) / sum(rate(http_request_duration_seconds_count{env="prod"}[5m]))` |
| **Latency** | fraction of requests served in under 300ms | `sum(rate(http_request_duration_seconds_bucket{le="0.3",env="prod"}[5m])) / sum(rate(http_request_duration_seconds_count{env="prod"}[5m]))` |

Both are ratios between 0 and 1. An SLO is just "this ratio should be ≥ some target,
measured over a longer window than 5 minutes."

## SLO targets — 99.99% availability is the base for every calculation in this repo

**99.99% ("four nines") is the availability number every SLO/error-budget calculation
in this doc set is built on.** It's a genuinely strict target — worth being honest
about exactly how strict before committing to it as a gate (step 4 blocks real
deployments on this number):

| SLO | Allowed downtime per 30-day window | Allowed downtime per year |
|---|---|---|
| 99% | ~7.2 hours | ~3.65 days |
| 99.5% | ~3.6 hours | ~1.83 days |
| 99.9% | ~43.2 minutes | ~8.76 hours |
| **99.99%** | **~4.3 minutes** | **~52.6 minutes** |
| 99.999% | ~26 seconds | ~5.3 minutes |

Same 99.99% target for every environment (dev/qa/prod) — only prod's is actually
*enforced* (step 4 gates deployment on it). Dev/qa are measured and shown on the same
dashboard against the same number, but breaching it there only ever produces a visible
signal, never a blocked deployment — you want to *see* dev/qa drift before it becomes a
habit, without stopping iteration in environments nothing depends on:

| Environment | Availability SLO | Latency SLO | Window | Enforced? |
|---|---|---|---|---|
| dev | 99.99% | 95% under 300ms | 7 days | no — dashboard only |
| qa | 99.99% | 95% under 300ms | 7 days | no — dashboard only |
| **prod** | **99.99%** | **95% under 300ms** | **30 days** | **yes — gates deployment (step 4)** |

## The error budget, worked with real numbers

99.99% → error budget is **0.01%** (`1 − 0.9999`) of requests over the window. Two ways
to see how small that actually is, both worth having on hand — the deployment gate in
step 4 works in the second (request-count) form, but the first is the one people
actually feel:

**Time-based** (a 30-day month ≈ 2,592,000 seconds):
```
allowed downtime = 2,592,000 × 0.0001 = 259.2 seconds ≈ 4.3 minutes / month
```

**Request-based**, assuming this app sees roughly 50,000 requests/day in prod (a
placeholder — swap in your own real traffic once you have it):
```
30-day request volume:   50,000 × 30 = 1,500,000 requests
error budget (0.01%):    1,500,000 × 0.0001 = 150 failed requests allowed
```

That's the number the deployment gate in step 4 actually checks: not "is anything
currently broken," but "have we spent more than 150 failed requests' worth of budget in
the last 30 days." At this strictness, **that budget is easy to blow through in a
single bad deploy** — 150 failed requests at even modest traffic is minutes, not days,
of a real incident. That's the point of choosing four nines deliberately rather than
by default: it makes the gate in step 4 mean something, but it also means the alerting
in step 3 has to be fast and reliable, because there is very little room for it to be
slow.

## What "recovers" means

Error budgets are computed over a **rolling** window, not a fixed calendar period — as
old failures age out of the 30-day window, budget comes back automatically, without
anyone doing anything. This is part of why the window size matters as a real design
choice: a 30-day window means one very bad day takes weeks to fully age out of the
budget calculation; a 7-day window (used for dev/qa above) recovers much faster but is
noisier. Sloth (step 2) computes this rolling-window math for you — this is the last
place in this doc you'll need to reason about it by hand.

Next: [`02-implementation-sloth.md`](02-implementation-sloth.md) — turn these numbers
into real Prometheus rules.
