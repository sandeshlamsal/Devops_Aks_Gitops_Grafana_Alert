# Step 5 — incident management: auto-ticketing + postmortems

Two pieces, both reusing what this repo already has rather than adding a dedicated
incident tool (PagerDuty/Opsgenie/etc. are the real answer at real scale — genuinely
overkill for this app's current size, and worth naming as the honest "what you'd
actually use in production" alternative rather than pretending GitHub Issues scales
indefinitely).

## Auto-open a GitHub Issue when the page alert fires

No new long-running infrastructure — a scheduled GitHub Action polling Alertmanager,
consistent with how every other cross-cutting check in this repo already runs (CI on
push, promotion checks in workflow jobs) rather than standing up a webhook receiver
that has to be hosted somewhere and kept alive.

```yaml
# .github/workflows/slo-incident-ticketing.yml
name: SLO incident ticketing

on:
  schedule:
    - cron: "*/5 * * * *"   # every 5 minutes — matches step 3's shortest alert window
  workflow_dispatch: {}      # manual trigger, for testing this workflow itself

permissions:
  contents: read
  issues: write
  id-token: write

jobs:
  check-and-ticket:
    runs-on: ubuntu-latest
    steps:
      - uses: azure/login@v2
        with:
          client-id: ${{ vars.AZURE_CLIENT_ID }}
          tenant-id: ${{ vars.AZURE_TENANT_ID }}
          subscription-id: ${{ vars.AZURE_SUBSCRIPTION_ID }}
      - uses: azure/aks-set-context@v4
        with:
          resource-group: ${{ vars.AKS_RESOURCE_GROUP }}
          cluster-name: ${{ vars.AKS_CLUSTER_NAME }}
      - uses: azure/setup-kubectl@v4

      - name: check Alertmanager for a firing page-severity alert
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          kubectl -n monitoring port-forward svc/kube-prom-stack-kube-prome-alertmanager 9093:9093 &
          PF_PID=$!
          for i in $(seq 1 15); do curl -sf http://localhost:9093/-/ready >/dev/null 2>&1 && break; sleep 1; done

          FIRING=$(curl -s http://localhost:9093/api/v2/alerts \
            | jq '[.[] | select(.labels.severity=="page" and .status.state=="active")] | length')
          kill $PF_PID 2>/dev/null || true

          [ "$FIRING" -eq 0 ] && { echo "nothing firing"; exit 0; }

          # idempotency: don't open a second ticket for the same ongoing incident —
          # check for an already-open incident issue before creating a new one
          EXISTING=$(gh issue list --label incident --state open --json number -q 'length')
          if [ "$EXISTING" -gt 0 ]; then
            echo "incident issue already open, not creating a duplicate"
            exit 0
          fi

          gh issue create \
            --title "[INCIDENT] user-management-app-api prod error budget burning fast" \
            --label incident \
            --body "Auto-opened by \`UserManagementAppApiErrorBudgetBurn\` (severity=page) — see [SRE/03-alerting-and-burn-rate.md](../SRE/03-alerting-and-burn-rate.md) for what this alert means. \`promote-prod.yml\` is now refused (see [SRE/04-deployment-gating.md](../SRE/04-deployment-gating.md)) until this is resolved. Fill in the postmortem template below once mitigated."
```

Deliberately conservative: it only opens **one** issue per ongoing incident (checks for
an already-open `incident`-labeled issue first), and it never auto-closes one — closing
an incident ticket is a judgment call a person makes after confirming things are
actually fixed, not something a burn-rate metric dropping below a threshold should
decide on its own.

## The postmortem format

This repo already has a working postmortem log — `PR-README.md`, "the record of every
real problem hit deploying this repo to a live AKS cluster." Extend the same format for
SLO-breach incidents specifically, filled in on the auto-opened issue (or copied into
`PR-README.md` once resolved, same as every other real problem this project has hit):

```markdown
## <date> — [INCIDENT] user-management-app-api prod error budget burning fast

**Detected:** <timestamp> — `UserManagementAppApiErrorBudgetBurn` (severity=page) fired,
auto-opened issue #<N>.

**Budget impact:** <e.g. "consumed ~40 of the 150-request 30-day budget (step 1) in
12 minutes before mitigation">.

**What broke:** <plain description>.

**Root cause:** <the actual cause, not just the symptom>.

**Mitigation (stopped the bleeding):** <what was done immediately — e.g. rollback via
the root README's Rollback section>.

**Fix (prevents recurrence):** <the real fix, and the commit>.

**Time to mitigate:** <alert fired → bleeding stopped>.
**Time to resolve:** <alert fired → root-caused and fixed>.

**Did the deployment gate (step 4) work as intended?** <yes/no — did it correctly
block `promote-prod` during this incident, or was the incident from something the
gate can't see, like an infra failure unrelated to a recent deploy?>
```

That last question matters: the gate in step 4 only stops *new deployments* — it does
nothing to fix an incident already in progress from an unrelated cause (a dependency
outage, a bad node, etc.). Track whether the gate was actually relevant each time, so
the SLO program's real value gets evaluated honestly over time, not assumed.

Next: [`06-dashboard.md`](06-dashboard.md) — seeing the error budget and its burn-down
in Grafana, tying the whole program together visually.
