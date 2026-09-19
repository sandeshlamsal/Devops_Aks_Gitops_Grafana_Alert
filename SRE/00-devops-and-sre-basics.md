# Step 0 — DevOps and SRE, from zero

This is the doc to read first if any of the words in `01`–`06` (Kubernetes, GitOps,
operator, CRD, Prometheus, PromQL, SLO) are unfamiliar. It's long on purpose — every
concept is introduced by first explaining the problem it solves, then showing exactly
where it lives in *this* repo, so nothing here is abstract. If you already know
Kubernetes and Prometheus, skip straight to
[`01-slis-and-slos.md`](01-slis-and-slos.md).

## Part A — DevOps, from the ground up

### The problem DevOps exists to solve

Before DevOps was a word, most companies had two separate teams: **developers**, who
wrote code, and **operations**, who ran it on real servers. Developers wanted to ship
new features fast. Operations wanted the servers to stay up and not break — which
often meant resisting change, because change is what causes outages. These two goals
were in tension, and the teams were often organizationally separate, sometimes even
hostile to each other ("it worked on my machine" vs. "then why did it just crash my
server").

**DevOps** is the idea that these shouldn't be separate concerns handled by separate
teams throwing work over a wall — the people writing the software should also be
responsible for how it runs in production, using automation to make shipping changes
both fast *and* safe, instead of picking one. This whole repository is a worked example
of DevOps practice: one team's code, tests, infrastructure, deployment pipeline, and
monitoring, all living together in one place, all automated.

### Containers — packaging an app so it runs the same everywhere

A **container** is a way of packaging an application together with everything it needs
to run (its code, its dependencies, its runtime) into one portable unit, so it behaves
identically on a developer's laptop, in a test environment, and in production — no more
"works on my machine." **Docker** is the tool that builds and runs containers from a
recipe file called a `Dockerfile`.

This repo has two: `apps/user-management-app/api/Dockerfile` (packages the Node.js API)
and `apps/user-management-app/ui/Dockerfile` (packages the built React app, served by
nginx). Every environment — your laptop, dev, qa, prod — runs the *exact same
container image*; only configuration (environment variables) differs between them. This
is a core practice you'll see referenced constantly in this repo as "build once, promote
everywhere" — and it's the whole reason the SLO work in `01`–`06` can trust that qa's
behavior predicts prod's: they're running identical bytes.

### Kubernetes — running containers reliably, at scale

One container on one server is easy to run by hand. Running dozens of containers,
across multiple servers, making sure a crashed one restarts automatically, routing
traffic to whichever copies are healthy, and doing all of this without a human watching
24/7 — that's a much harder problem, and it's what **Kubernetes** (often shortened to
"K8s") solves. Kubernetes is a system that takes a *description* of what you want
running ("I want 2 copies of this container, listening on this port") and continuously
works to make reality match that description — including noticing if a copy dies and
starting a replacement, without anyone asking it to.

The building blocks you'll see everywhere in this repo:

| Kubernetes object | What it is | Where in this repo |
|---|---|---|
| **Pod** | The smallest runnable unit — one or more containers running together | `kubectl get pods -n user-management-app-dev-ns` shows the API, UI, and database pods |
| **Deployment** | "Keep N copies of this Pod running, replace any that die" | `apps/user-management-app/k8s/base/api.yaml` |
| **Service** | A stable network address that routes to whichever Pods are currently healthy | Same file — `user-management-app-api` Service, so other Pods can reach the API without knowing which specific Pod is currently running it |
| **Namespace** | A named subdivision of the cluster — isolates one group of things from another | `user-management-app-dev-ns` / `-qa-ns` / `-prod-ns` — this is *why* dev/qa/prod can't see each other's data (see `apps/user-management-app/README.md`'s "Common scenarios" section) |
| **ConfigMap / Secret** | Configuration and sensitive values, kept separate from the container image itself | `JWT_SECRET`, `DATABASE_URL` — see `infrastructure/secrets/README.md` |

**AKS** (Azure Kubernetes Service) is just "Kubernetes, run for you by Azure" — you
don't manage the physical servers, Azure does; you still describe what you want
running, the same way.

### Infrastructure as Code, and why "just SSH in and fix it" doesn't scale

Early on, operations teams managed servers by hand — SSH in, run a command, edit a
config file. This doesn't scale (you can't hand-configure a thousand servers) and isn't
safe (nobody can tell you exactly what's different between two servers that are
supposedly identical, because the changes were never written down anywhere).
**Infrastructure as Code** means describing your entire system — servers, networking,
application config, everything — as files that live in version control (git), the same
way you'd manage application source code. The description *is* the source of truth; the
running system is just a reflection of it.

Every `.yaml` file in this repo's `apps/`, `infrastructure/`, and `clusters/` folders is
infrastructure-as-code — a description of what should be running, not a record of
commands someone ran once.

### GitOps — Infrastructure as Code, continuously enforced

**GitOps** takes Infrastructure as Code one step further: instead of a human (or a
script) running `kubectl apply` whenever the description changes, a piece of software
running *inside* the cluster continuously watches the git repository and applies any
change automatically — and just as importantly, if someone manually changes something
on the live cluster (a "drift"), GitOps reverts it back to what git says, because git is
the only source of truth that's allowed to win.

**Flux** is the GitOps tool this repo uses. Its `source-controller` watches this GitHub
repo for new commits; its `kustomize-controller` applies the YAML files it finds. This
is why nothing in this repo is ever `kubectl apply`-ed by hand — every change is a git
commit, and Flux does the actual applying, on its own schedule (every few minutes,
configurable per `Kustomization` — see any file in `clusters/dev/`).

### Operators and CRDs — Kubernetes, extended for anything

Kubernetes ships knowing about Pods, Deployments, Services, and a handful of other
built-in object types. But this repo runs a Postgres database, a Grafana dashboard
system, a certificate manager, an SLO calculator — none of those are things Kubernetes
knows about natively. **Custom Resource Definitions (CRDs)** let you teach Kubernetes
about a *new* kind of object (e.g. "a Postgres database cluster"), and an **Operator**
is a piece of software that watches for objects of that new kind and does whatever
real-world work is needed to make them exist (provisioning a Postgres cluster,
configuring Grafana, issuing a certificate).

This is the single most-repeated pattern in this entire repository: **you write a small
YAML object describing what you want, an operator makes it real.** A few examples,
concrete rather than abstract:

- You write a `Cluster` custom resource (`apps/user-management-app/k8s/base/db-cluster.yaml`)
  → the **CloudNativePG operator** provisions a real, running Postgres database
- You write a `GrafanaDashboard` custom resource (`infrastructure/grafana/dashboard.yaml`)
  → the **Grafana Operator** makes that dashboard actually appear in Grafana
- You write a `PrometheusServiceLevel` custom resource (`apps/user-management-app/k8s/base/slo.yaml`,
  covered starting in `02-implementation-sloth.md`) → **Sloth's operator** generates
  the real Prometheus alerting rules

Once you recognize this pattern, most of this repo's YAML stops looking like magic
config and starts looking like exactly what it is: "here's what I want, let the right
piece of software build it."

### CI/CD — automating the path from code change to running system

**CI** (Continuous Integration) means automatically testing every code change the
moment it's proposed, before it merges — catching problems immediately instead of
discovering them days later. **CD** (Continuous Delivery/Deployment) means automating
the path from "code merged" to "running in an environment," instead of a person
manually copying files around.

`.github/workflows/ci.yml` is this repo's CI: every push runs the test suite, builds
the container images, and (only if tests pass) pushes them. `promote-dev.yml`,
`promote-qa.yml`, `promote-prod.yml` are the CD side — see the root README's §6 for the
full pipeline. The `SLI`s this SRE program measures (`01-slis-and-slos.md`) are
measuring the *output* of this exact pipeline — every deploy is a chance to break the
SLO, which is exactly why `04-deployment-gating.md` hooks directly into
`promote-prod.yml`.

## Part B — Observability: how you know what's actually happening

### The three kinds of telemetry

Once your system is running as containers, spread across a cluster, you can't just SSH
in and look at a log file the way you could on one server — you need your
*application* to tell you what it's doing. There are three standard kinds of signal:

- **Metrics** — numbers over time (how many requests, how long did they take, how much
  memory is used). Cheap to store, great for dashboards and alerting, but tell you
  *that* something is wrong, not always *why*.
- **Logs** — individual text records of specific events ("user X logged in at time Y").
  Detailed, but expensive to search through at scale.
- **Traces** — the path a single request took through multiple services, with timing
  for each step. Best for understanding *why* one specific request was slow.

This repo's `apps/user-management-app/api/src/server.js` emits metrics (via
`prom-client`); `apps/user-management-app/docs/local-observability.md` covers logs and
traces in depth if you want to go further into those. **This SRE program (`01`–`06`) is
built entirely on metrics** — SLOs are fundamentally about "what fraction of requests
met a target," which is exactly what a metric answers well and a full trace doesn't
need to.

### Prometheus — the metrics database

**Prometheus** is a system that periodically fetches ("scrapes") metrics from every
application that exposes them, stores them as a time series (a number, with a
timestamp, forever), and lets you query that history. The API in this repo exposes a
`/metrics` endpoint (`prom-client` does this automatically); a `ServiceMonitor` object
tells Prometheus "here's something to scrape" (see `apps/user-management-app/k8s/base/api.yaml`).

**PromQL** is the query language you use to ask Prometheus questions. A few building
blocks you'll see throughout `01`–`06`:

- `http_request_duration_seconds_count` — a **counter**: a number that only ever goes
  up (total requests served since the app started). Counters are useless on their own
  (you don't care about the raw total) — you almost always wrap them in `rate(...)`.
- `rate(http_request_duration_seconds_count[5m])` — "how fast is this counter
  increasing, averaged over the last 5 minutes" — turns a raw ever-growing total into
  "requests per second right now," which is the number you actually care about.
- `sum(...)` — adds up a metric across every Pod reporting it (there are multiple API
  Pod replicas in prod — you want one combined number, not one per Pod).
- `http_request_duration_seconds_bucket{le="0.3"}` — a **histogram** bucket: "how many
  requests took 0.3 seconds or less." This is exactly the mechanism
  `01-slis-and-slos.md`'s Step 0 depends on — without a bucket boundary *at* your SLO
  threshold, you cannot compute "what fraction were under 300ms."
- `{status=~"5.."}` — a **label filter**: `status` is a label attached to the metric
  (from `server.js`'s `labelNames: ["method", "route", "status"]`); `=~"5.."` is a regex
  match, "starts with 5" — i.e. any 5xx error status code.

Put together: `sum(rate(http_request_duration_seconds_count{status=~"5.."}[5m])) /
sum(rate(http_request_duration_seconds_count[5m]))` — from `01-slis-and-slos.md` — reads
as "the rate of 5xx responses, divided by the rate of all responses, over the last 5
minutes" — i.e. exactly the availability SLI. Every scary-looking PromQL expression in
this doc set decomposes the same way once you know these five pieces.

### Grafana — visualizing what Prometheus knows

**Grafana** is a dashboarding tool that queries Prometheus (and other data sources) and
turns the results into graphs, gauges, and tables a human can actually look at.
`06-dashboard.md` builds a real Grafana dashboard for the SLO program — but the
*existing* "User Management App" dashboard (`infrastructure/grafana/json/user-management-app.json`)
is worth opening first if you've never used Grafana, since it's simpler.

### Alertmanager — turning "a metric crossed a threshold" into "someone gets notified"

Prometheus can evaluate a rule continuously ("is the error rate above X") and mark it
as **firing** the moment that's true — but Prometheus itself doesn't send emails or
pages. **Alertmanager** is the separate piece of software that receives firing alerts
from Prometheus and decides what to do with them: group related alerts together, route
different alerts to different people/channels, and avoid spamming the same alert
repeatedly. `infrastructure/alert/alertmanager-config.yaml` is this repo's routing
configuration — it's what `03-alerting-and-burn-rate.md`'s page/ticket severities
actually route through.

## Part C — what SRE adds on top of all of this

**Site Reliability Engineering (SRE)** is Google's specific approach to the DevOps
problem, with one defining idea that's stricter than "just monitor things and add
alerts": **reliability should be measured with a number, a target should be agreed on
in advance, and that target should have real consequences** — not "we'll try to keep
things stable," but "here is exactly how unstable we've agreed is acceptable, here is
how we're tracking it in real time, and here is what happens when we've used up that
allowance."

That's the entire arc of `01`–`06`:

1. **Pick a number you can actually measure** (an SLI) — not a vague feeling
2. **Agree on a target for that number** (an SLO) — a real commitment, not an aspiration
3. **Turn "missing the target" into a spendable budget** (the error budget) — reframes
   "zero failures ever" (impossible, and not actually what anyone needs) into "a known,
   trackable amount of acceptable failure"
4. **Get warned before the budget's gone**, not after (burn-rate alerting)
5. **Make the budget mean something operationally** — spending it too fast actually
   *stops new deployments* (the gate), not just triggers a dashboard nobody looks at
6. **Have a real process for when it does happen** (incident management) — because a
   number and an alert without a "then what" is not actually a reliability practice

Every other DevOps practice in Part A and B of this doc — containers, Kubernetes,
GitOps, CI/CD, metrics, dashboards, alerting — is infrastructure SRE is built *on top
of*, not a replacement for it. You need all of Part A/B working before "SLI/SLO/error
budget" means anything real, which is exactly why this repo had to exist first, and why
`01-slis-and-slos.md` assumes everything in this doc as already understood.

Next: [`01-slis-and-slos.md`](01-slis-and-slos.md).
