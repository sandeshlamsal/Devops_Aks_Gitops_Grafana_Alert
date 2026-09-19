# Step 4 — the actual circuit breaker: gate deployment on the error budget

This is the piece that makes everything in steps 1–3 more than a dashboard: **if
prod's error budget is being burned fast right now, `promote-prod.yml` refuses to
promote, full stop, before it does anything else.**

## What condition actually gates the promotion

Not "is the 30-day budget already fully exhausted" — by the time that's true, the
damage is already done, and blocking deployment at that point doesn't undo it. The gate
checks the same signal step 3's `page`-severity alert checks: **is the fast-burn
condition (14.4x over both the 1h and 5m windows) currently firing.** If it is, prod is
actively having a bad time right now — adding a new deployment's risk on top of an
active incident is exactly the wrong moment to do it.

## Where it goes in the pipeline

`promote-prod.yml` already authenticates to Azure and gets a `kubectl` context — today
that happens *after* the PR is opened, near the end of the job. For the gate to mean
"refuse to promote" rather than "open the PR but maybe not arm it," that Azure/kubectl
setup needs to move to the **very top** of the job, before the ACR-tag check even runs
— fail as early and as cleanly as possible:

```yaml
# .github/workflows/promote-prod.yml — reordered job steps
jobs:
  promote-prod:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
      - uses: azure/login@v2
        with:
          client-id: ${{ vars.AZURE_CLIENT_ID }}
          tenant-id: ${{ vars.AZURE_TENANT_ID }}
          subscription-id: ${{ vars.AZURE_SUBSCRIPTION_ID }}

      # moved up from near the end of the job — the gate below needs kubectl access
      # before anything else happens, not after a PR is already open
      - uses: azure/aks-set-context@v4
        with:
          resource-group: ${{ vars.AKS_RESOURCE_GROUP }}
          cluster-name: ${{ vars.AKS_CLUSTER_NAME }}
      - uses: azure/setup-kubectl@v4

      - name: check prod's error budget before doing anything else
        run: |
          kubectl -n monitoring port-forward svc/kube-prom-stack-kube-prome-prometheus 9090:9090 &
          PF_PID=$!
          for i in $(seq 1 15); do curl -sf http://localhost:9090/-/ready >/dev/null 2>&1 && break; sleep 1; done

          FIRING=$(curl -s 'http://localhost:9090/api/v1/query' \
            --data-urlencode 'query=ALERTS{alertname="UserManagementAppApiErrorBudgetBurn",severity="page",alertstate="firing",namespace="user-management-app-prod-ns"}' \
            | jq '.data.result | length')

          kill $PF_PID 2>/dev/null || true

          if [ "$FIRING" -gt 0 ]; then
            echo "::error::prod's error budget is burning fast right now (page-severity alert firing)."
            echo "::error::Refusing to promote. Resolve the active incident first — see the Grafana dashboard (step 6) and Alertmanager, then re-run this workflow."
            exit 1
          fi
          echo "error budget OK — proceeding with promotion"

      # everything below this line is unchanged from before — ACR check, overlay
      # bump, PR — except aks-set-context / setup-kubectl are removed from their old
      # spot further down, since they now run once, above
      - name: verify the version exists in ACR for both images
        run: |
          az acr repository show-tags -n ${{ vars.ACR_NAME }} --repository user-management-app-api -o tsv | grep -qx "${{ inputs.version }}"
          az acr repository show-tags -n ${{ vars.ACR_NAME }} --repository user-management-app-ui  -o tsv | grep -qx "${{ inputs.version }}"
      # ... bump prod image tags, open PR, arm prod — unchanged
```

`promote-qa.yml` gets the identical gate (same shape, `namespace=user-management-app-qa-ns`)
— but remember from step 1: **qa's SLO isn't enforced**, only measured. So should qa's
promotion actually be gated too? That's a real design choice, not an obvious yes:

- **Argument for gating qa too**: catches a bad build before it ever reaches prod,
  earlier than prod's own gate would.
- **Argument against**: qa is explicitly the environment meant to absorb bad builds
  safely — gating it the same way as prod removes the one environment where you're
  supposed to be able to break things without consequence.

This doc set gates **prod only**, consistent with step 1's "prod is the one commitment
that's enforced" design. Add the same block to `promote-qa.yml` if you decide
otherwise — the code is identical except the namespace.

## What "resolve it, then retry" actually means

The gate doesn't auto-clear — someone has to actually fix whatever's burning the
budget (this is what step 5's incident management is for), and re-run
`promote-prod.yml` once the `page` alert stops firing. This is deliberate: a
self-healing gate that silently retries until it passes would defeat the entire point
of having a human look at why prod started failing in the first place.

## Verify it (once deployed)

```bash
# force the gate to trip: manually fire a synthetic error-budget-burn condition
# (or reuse step 3's dev-objective trick, pointed at prod's namespace temporarily)
gh workflow run promote-prod.yml -f version=v1.0.0
# expect: the job fails at "check prod's error budget before doing anything else",
# no PR opened, no overlay bump — confirm via `gh pr list`, should show nothing new
```

Next: [`05-incident-management.md`](05-incident-management.md) — what actually happens
when the alert this gate checks starts firing.
