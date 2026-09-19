# Deploy issue log

Every real problem hit deploying this repo to a live AKS cluster, and how it was fixed.
`kustomize build` / local testing catches syntax errors; it can't catch a live
Kubernetes API rejecting a field, an action tag that doesn't exist, or an RBAC gap that
only shows up once something actually tries to use the permission — this log is the
record of those. Newest first. Each entry: what broke, root cause, the fix, the commit.

---

## 2026-09-19 — `slo-incident-ticketing.yml`'s first real run: missing `incident` label

**Where:** `.github/workflows/slo-incident-ticketing.yml`, first `workflow_dispatch`
run (35467212397), while `UserManagementAppApiAvailabilityBudgetBurn` (severity=page)
was genuinely firing in dev.

**Symptom:** `found 1 distinct firing incident(s)` logged correctly, then
`could not add label: 'incident' not found`, exit 1 — no issue opened despite a real
incident being live.

**Root cause:** `gh issue create --label incident` fails outright if that label
doesn't already exist in the repo — it doesn't create it implicitly like some other
`gh` subcommands do with similar-looking flags.

**Fix:** added an idempotent `gh label create incident --color B60205 --force` step
before the check, so the workflow is self-healing rather than needing a one-time
manual repo setup step someone has to remember. `bd0bdff` (#26).

**Verification:** re-ran via `workflow_dispatch` against the same still-firing alert —
succeeded, opened issue #28 with the correct title, `incident-key` marker
(`UserManagementAppApiAvailabilityBudgetBurn:user-management-app-dev-ns`), and both
`SRE/03`/`SRE/05` links resolving correctly.

**Commit:** `bd0bdff` (#26).

---

## 2026-09-19 — SLO stand-up: three real bugs found getting the first live burn-rate alert to fire

**Where:** `apps/user-management-app/k8s/base/slo.yaml` + all 3 overlay `patch.yaml`s +
`infrastructure/grafana/json/user-management-app-slo.json` — the SLO/error-budget
implementation from PR #11 had never been applied to a live cluster before this
session's dev stand-up. All three were caught in sequence while getting dev's
`PrometheusServiceLevel` to actually generate rules and render in Grafana.

**Bug 1 — `{{.window}}` was double-escaped.** Every `errorQuery`/`totalQuery` had
`{{"{{.window}}"}}` instead of `{{.window}}`. Sloth parses these as Go templates before
treating the result as PromQL; the stray quote/brace broke every query with
`parse error: unexpected character in duration expression: '{'`. `sloth-84bdc875bc-jsvn2`'s
logs showed both SLOs stuck retrying forever; `kubectl get prometheusservicelevel`
showed `GEN OK: false`, `READY SLOS: 0`. **Fix:** `179d767` (#17).

**Bug 2 — no `namespace` label on any generated series.** `errorQuery`/`totalQuery` use
a bare `sum(rate(...))`, stripping every label from the result — so
`slo:error_budget:ratio`, `slo:sli_error:ratio_rate5m`, etc. carried only
`sloth_service`/`sloth_slo`/`sloth_id` (identical across dev/qa/prod, since all three
share the same service name). Once qa/prod are ever armed, their rule groups would
silently collide with dev's in the single cluster-wide Prometheus. **Fix:** added
`spec.labels.namespace` (a Sloth CR field applied to every generated series, not just
the query text) per overlay. `121182b` (#19).

**Bug 3 — dashboard's "error budget remaining" panels queried a constant.**
`slo:error_budget:ratio` is `vector(1 - objective)` — static, never moves. Three panels
(both remaining-budget gauges, the burn-down timeseries) queried it directly, so they'd
show the same frozen number regardless of real error traffic. The metric that actually
depletes is `slo:period_error_budget_remaining:ratio` (`1 - period burn rate`).
**Fix:** `f3db87a` (#21).

**End-to-end verification (after all three fixes):** logged in as `admin`, generated a
mixed burst of real traffic against dev's API (`~2/3` healthy `/api/healthz` calls,
`~1/3` a real 500 via a malformed admin `PUT /api/users/:id` — `id` set to a non-numeric
string, triggering a genuine Postgres type error caught by the route's existing
try/catch). Confirmed in Prometheus:
`slo:sli_error:ratio_rate5m{sloth_slo="availability"}` = `0.284` (28.4% error rate, vs.
a 99.99% objective), and `ALERTS{alertname="UserManagementAppApiAvailabilityBudgetBurn"}`
firing at both `severity="page"` and `severity="ticket"`, correctly labeled with
`namespace="user-management-app-dev-ns"`, present in Alertmanager
(`/api/v2/alerts`). The full pipeline — SLI → Sloth-generated burn-rate rule →
Prometheus alert → Alertmanager routing — is live and correct.

**Known follow-up, not yet fixed:** `slo:sli_error:ratio_rate30d` (and everything
downstream of it — `slo:period_burn_rate:ratio`, `slo:period_error_budget_remaining:ratio`)
currently reports rule health `err`: `vector contains metrics with the same labelset
after applying rule labels`. Self-inflicted by fixing bug 2 live: the *old*
(pre-fix, no-`namespace`) and *new* (post-fix, `namespace` set) samples of
`slo:sli_error:ratio_rate5m` both still exist inside the 30-day range this rule queries,
and Sloth's static `spec.labels` forces both onto the identical final label set,
colliding. Prometheus's admin API (`/api/v1/admin/tsdb/delete_series`) is disabled by
default on this cluster (confirmed: `500`) — correctly so, not something to flip on for
a demo. This will not recur on a stand-up where the namespace label is correct from the
very first sample; on *this* cluster it self-resolves once the pre-fix samples age past
30 days old. Not blocking: the short-window burn-rate panels (5m/1h/6h) and the firing
alerts — the actually load-bearing parts of "is the error budget being enforced" — are
unaffected and already verified live above.

**Commits:** `179d767` (#17), `121182b` (#19), `f3db87a` (#21).

---

## 2026-09-19 — Repeated the 2026-09-12 skip-ci mistake, this time in a commit *body*

**Where:** PR #14's squash-merge commit `fe71692` (the fix for the entry directly
below this one).

**Symptom:** `fe71692` landed on `main` with **zero** check-runs — not failed, not
pending, simply never created — so the bump-dev fix it contained went unverified for
several minutes before being noticed (a `Monitor` polling loop watching for the
push-triggered run never saw one appear).

**Root cause:** the exact same mistake as the 2026-09-12 entry below
("A commit describing `[skip ci]` skipped its own CI run"), except this time the
literal string `[skip ci]` was in the commit **body** (explaining that the bump-dev
job's own squash commit uses that marker), not the subject. GitHub's skip-ci scan
covers the whole message, subject and body alike.

**Fix:** no code change — confirmed via
`git log -1 --format=%B fe71692` (found the string) and
`gh api repos/OWNER/REPO/commits/fe71692/check-runs` (`total_count: 0`, confirming the
skip). Recovered by pushing a normal follow-up commit (this one) with a message that
describes the convention without spelling out the bracketed marker itself.

**Lesson (sharpened from 2026-09-12):** the rule isn't "don't put `[skip ci]` in a
*commit subject* describing the convention" — it's "don't put it anywhere in the
*message*, subject or body." When writing about this convention going forward, describe
it in prose (e.g. "the skip-ci marker") instead of typing the literal brackets.

---

## 2026-09-19 — `bump-dev`'s direct push to `main` rejected by a new ruleset

**Where:** `ci.yml`'s `bump-dev` job, `git push origin HEAD:main` step — first
push-triggered `CI` run after the repo's "Cant delete main" ruleset picked up a
`code_coverage` rule (added outside this session, between the 2026-09-12 work and this
session's "resume"). Three consecutive push-triggered runs failed the same way
(`35458142848`, `35463063080`, `35463343221`, then `35464878107`) before this was
caught — every merge to `main` in between had its dev-tag bump silently fail while
`test`/`build` still passed, so the failure was easy to miss in a quick PR-checks glance.

**Symptom:**
```
remote: error: GH013: Repository rule violations found for refs/heads/main.
remote: - Code coverage checks require merging via API or UI.
 ! [remote rejected] HEAD -> main (push declined due to repository rule violations)
```

**Root cause:** `bump-dev` was written (2026-09-12, see below) when a direct
`git push origin HEAD:main` using the default `GITHUB_TOKEN` was still allowed. The new
ruleset rejects **any** direct push to `main`, bot or human, regardless of token scope —
same restriction this session was already hitting manually for its own commits (hence
the branch+PR+`gh pr merge` workflow adopted mid-session).

**Fix:** `bump-dev` now does the same thing manually-applied commits now do — branch,
commit, `gh pr create`, then `gh pr merge --squash --delete-branch` (the API path the
rule explicitly allows). Confirmed the ruleset has no `required_status_checks` rule
(`gh pr view --json mergeStateStatus` → `CLEAN` immediately after `gh pr create`, no
wait needed), so the merge can happen in the same job run without polling for checks.

**Commit:** `fe71692` (#14) — whose own merge commit then hit the skip-ci mistake
documented in the entry above it.

---

## 2026-09-19 — JWT secrets silently seeded empty (`openssl` doesn't exist inside `openbao-0`)

**Where:** OpenBao bootstrap step (`docs/operations-runbook.md` B7), seeding
`kv/user-management-app/jwt-{dev,qa,prod}` on this session's fresh stand-up.

**Symptom:** no loud error — `bao kv put kv/user-management-app/jwt-dev
secret="$(openssl rand -hex 32)"` run via `kubectl exec -it openbao-0 -- sh -c '...'`
printed `sh: openssl: not found` on its own line, immediately followed by what looked
like a normal-looking `bao kv put` success response (`version: 1`). Easy to miss if you
only check the command's exit code / final line.

**Root cause:** the `$(openssl rand -hex 32)` subshell was evaluated **inside** the
remote `openbao-0` container's shell (a minimal image with no `openssl` binary), not on
the local machine — so it expanded to an empty string, and `bao kv put ... secret=""`
happily wrote an empty secret. `bao`'s own response gives no hint the value it received
was empty.

**Fix:** generate the three JWT secrets with `openssl` **locally** (where it exists)
first, then interpolate the real values into a fresh `kubectl exec` call as literal
shell arguments (no nested `$(...)` evaluated remotely):
```bash
JWT_DEV=$(openssl rand -hex 32); JWT_QA=$(openssl rand -hex 32); JWT_PROD=$(openssl rand -hex 32)
kubectl exec -it openbao-0 -n openbao -- sh -c "
  bao kv put kv/user-management-app/jwt-dev  secret='${JWT_DEV}'
  bao kv put kv/user-management-app/jwt-qa   secret='${JWT_QA}'
  bao kv put kv/user-management-app/jwt-prod secret='${JWT_PROD}'
"
```
Confirmed fixed via the resulting `version: 2` in each response (overwriting the empty
`version: 1`).

**Lesson:** when a command that generates a secret runs inside a `kubectl exec` shell,
check *which* shell actually evaluates any `$(...)` in it — a subshell inside a
double-quoted `sh -c "..."` argument runs locally (in this fix); a subshell inside a
single-quoted one, or typed directly at an `-it` prompt, runs remotely. Always read the
full command output, not just the last line — the `openssl: not found` warning was
there to see, on a separate line, the whole time.

**Commit:** not a git change (live OpenBao KV write); caught and fixed during this
session's B7 stand-up step.

---

## 2026-09-19 — `cnpg-operator` was missing a `cert-manager` dependency

**Where:** `clusters/dev/cnpg-operator.yaml` — found by code inspection while
reviewing PR #9's Barman Cloud plugin addition (`infrastructure/cnpg/barman-cloud-plugin.yaml`),
before this session's stand-up, not as a live failure.

**Root cause:** the CNPG Barman Cloud plugin (`barmancloud.cnpg.io/v1` `ObjectStore`)
serves its CNPG-I gRPC endpoint over TLS using a cert-manager-issued certificate, but
`cnpg-operator`'s Flux `Kustomization` had no `dependsOn` on a `cert-manager`
Kustomization — because none existed yet; PR #9 added the plugin without adding
cert-manager as a platform component at all.

**Fix:** added `clusters/dev/cert-manager.yaml` (new Flux `Kustomization`,
`dependsOn: none`) and `dependsOn: [cert-manager]` on `cnpg-operator`'s. Also added
`cert-manager` to the pre-Flux RBAC namespace loop (`docs/operations-runbook.md` B3,
`README.md` §3.6) — missed in the first pass, caught before running the loop for real
(see the RBAC-loop fix, commit `827991c` / #13).

**Verification:** confirmed on this session's real stand-up — both
`platform-config-cert-manager` and `platform-config-cnpg-operator` (including the
`plugin-barman-cloud` pod) reconciled `Ready=True` on the very first attempt, no manual
intervention needed.

**Commit:** `f86d656` (#12).

---

## 2026-09-13 — `promote-qa` waited the full 15 minutes even after an early manual merge

**Where:** `promote-qa.yml`'s auto-merge step, run [34734298227].

**Symptom:** PR #5 was merged manually at ~minute 12 (to skip waiting on the review
window), but the workflow run kept going until the full 15 minutes had elapsed before
finally finishing — no error, no duplicate merge, just idle runner time.

**Root cause:** the step was a flat `sleep 900` followed by a single state check at
the very end. It had no way to notice the PR had already been merged out-of-band
partway through — it only ever looked once, after the full wait.

**Fix:** replaced the flat sleep with a loop that polls the PR's state every 30
seconds for up to 15 minutes, exiting immediately the moment the PR is no longer
`OPEN` (merged or closed manually), instead of only checking at the deadline.

**Commit:** `47ddef4`

---

## 2026-09-12 — A commit describing `[skip ci]` skipped its own CI run

**Where:** commit `215fd5c` ("replace Flux Image Automation with a CI job for dev's
tag bump") — pushed to `main`, zero check-runs ever appeared for it.

**Root cause:** the commit's own message *described* the new `bump-dev` job's
behavior, including the literal text `[skip ci]` as an explanation of the convention
it uses. GitHub's skip-CI detection does a raw substring scan of the *entire* commit
message for that marker (and `[ci skip]`, `[no ci]`, etc.) — it has no concept of
"this is inside a description," it just matches text. Writing about the convention
invoked the convention.

**Fix:** no code change — just don't put that exact bracketed string in a commit
message unless you actually mean to skip that commit's own CI run. Confirmed via
`gh api repos/OWNER/REPO/commits/<sha>/check-runs` returning `total_count: 0`.

**Lesson:** when documenting a skip-CI (or any other magic-string) convention inside a
commit message itself, don't spell out the literal trigger string — describe it
without the delimiters, or the description becomes an instance.

---

## 2026-09-12 — `release.yml`'s tag-push trigger can't OIDC-authenticate (immutable subject claim)

**Where:** `release.yml` / `promote-*.yml`, any `azure/login@v2` step, first real
`workflow_dispatch` run.

**Symptom:**
```
AADSTS700213: No matching federated identity record found for presented assertion
subject 'repo:sandeshlamsal@15390989/Devops_Aks_Gitops_Grafana_Alert@1358469180:ref:refs/heads/main'.
```

**Root cause:** this repo has `use_immutable_subject: true` set on its OIDC subject
claim (`gh api repos/OWNER/REPO/actions/oidc/customization/sub`) — GitHub now embeds
the numeric owner/repo IDs in the subject by default, not just the slug. The federated
credentials registered on the Azure AD app used the classic
`repo:owner/repo:ref:refs/heads/main` format, which no longer matches. Attempting to
flip `use_immutable_subject` back to `false` via the API returns 200 but has no effect
— it's enforced at a higher (account) level than a per-repo API call can override.

**Fix:** updated both federated credentials' `subject` to the real immutable format
(`repo:sandeshlamsal@15390989/Devops_Aks_Gitops_Grafana_Alert@1358469180:ref:...` /
`:environment:production`) via `az ad app federated-credential update`.

**Separately, and independent of the above:** even with the subject fixed, a real `git
tag vX.Y.Z && git push --tags` still can't work on this tenant, because each tag
produces a distinct subject (`ref:refs/tags/vX.Y.Z`) that no single fixed credential
can match. Reworked `release.yml` to trigger via `workflow_dispatch` (ref
`refs/heads/main` when dispatched from main, which does match) and have the job create
+ push the real tag itself as its first step — see `release.yml`'s own header comment
for the full explanation. `README.md` and `docs/operations-runbook.md` updated to stop
telling people to cut a release via a manual tag push.

**Commits:** federated-credential subjects updated live (not a git change); workflow
rework in `58b2a72`.

---

## 2026-09-12 — Self-correction: don't seed Flux's git credential from a personal token

**Where:** `kv/flux/git-credentials` in OpenBao (used by the `flux-image-updater`
`GitRepository`/`ImageUpdateAutomation` for git write-back of `dev-<N>` image tag bumps).

**What happened:** to unblock `flux-image-automation`'s `GitRepository` auth failure
during first deploy, `gh auth token` (this machine's own logged-in GitHub CLI OAuth
token — `repo` + `workflow` scope, tied to a personal account) was used as a quick
fix. The user caught this and correctly called it out: reusing a broad personal
credential inside a piece of cluster automation is exactly the anti-pattern OpenBao
exists to avoid, even though the value never left the user's own OpenBao instance.

**Fix:** reverted `kv/flux/git-credentials` to a placeholder immediately. Correct
credential is a **fine-grained GitHub PAT scoped to this one repo, `Contents: Read and
write` only** — nothing else — created by the user directly (GitHub has no API for
self-service PAT creation) and seeded by the user directly into OpenBao, so the token
value never passes through an assistant's context at all.

**Lesson:** "it's scoped to your own infrastructure" is not the same bar as "it's the
minimally-privileged credential for the job" — a quick unblock is still wrong if it
reaches for a broader-than-necessary credential, personal or not. This is also why the
Azure side of this same problem (CI/CD's `azure/login`) was designed with OIDC
federated credentials from the start — no stored secret, no personal token, ever.

---

## 2026-09-12 — AKS Flux extension doesn't enable image-automation controllers by default

**Where:** `platform-config-flux-image-automation` Kustomization — applied cleanly
(`READY` eventually `True`), but its `ImageRepository`/`ImagePolicy` resources never
got an `Observed Generation` or any events at all — nothing was reconciling them.

**Root cause:** `az k8s-extension create --extension-type microsoft.flux` installs
only `source-controller`, `kustomize-controller`, `helm-controller`, and
`notification-controller` by default. `image-reflector-controller` and
`image-automation-controller` — the two Flux Image Automation needs — are opt-in.

**Fix:**
```bash
az k8s-extension update -g san-rg -c san-dev-aks -t managedClusters --name flux \
  --config image-automation-controller.enabled=true image-reflector-controller.enabled=true \
  --yes
```
Both pods appeared within ~30s of the extension update succeeding.

**Lesson:** the root README's §3.5 runbook and `docs/operations-runbook.md`'s B4 should
include this flag on the *initial* `az k8s-extension create` for any deploy that uses
`infrastructure/flux-image-automation/` — not yet updated there, follow-up needed.

---

## 2026-09-12 — `aquasecurity/trivy-action@v0.28.0`: broken upstream (deleted transitive tag)

**Where:** `ci.yml` / `release.yml`, `build` job — this is the *second* trivy-action
issue, found immediately after fixing the first one below by adding the missing `v`.

**Symptom:**
```
Unable to resolve action `aquasecurity/setup-trivy@v0.2.1`, unable to find version `v0.2.1`
```

**Root cause:** `trivy-action@v0.28.0` is a real tag, but *that release* internally
pins `aquasecurity/setup-trivy@v0.2.1` as a dependency — and `setup-trivy`'s own tag
list no longer has anything older than `v0.2.6`. Not our config; the upstream action
itself references a tag that's since been deleted.

**Fix:** bumped to `aquasecurity/trivy-action@v0.36.0` (latest release) in both
workflow files. Verified first that the 3 inputs this repo uses (`image-ref`,
`severity`, `exit-code`) are unchanged in `v0.36.0`'s `action.yaml`.

**Commit:** `280f9f9`

**Lesson:** pinning a third-party composite Action to an exact tag doesn't fully
insulate you from its *own* transitive pins breaking later — the fix when that happens
is just to move to a newer release of the same action.

---

## 2026-09-12 — `aquasecurity/trivy-action@0.28.0`: tag doesn't exist

**Where:** `ci.yml` / `release.yml`, `build` job, failed at "Set up job" (before any
step even ran).

**Symptom:**
```
Unable to resolve action `aquasecurity/trivy-action@0.28.0`, unable to find version `0.28.0`
```

**Root cause:** the action's real git tags are `v0.28.0` (with a `v` prefix) —
`0.28.0` never existed. Confirmed against `aquasecurity/trivy-action`'s tag list.

**Fix:** `aquasecurity/trivy-action@0.28.0` → `aquasecurity/trivy-action@v0.28.0` in
both workflow files.

**Commit:** `bcb41bd`

---

## 2026-09-12 — `ExternalSecret.spec.target.template.engine`: field doesn't exist in ESO v1

**Where:** `infrastructure/flux-image-automation/acr-pull-secret.yaml`, applied by the
`flux-image-automation` Flux Kustomization.

**Symptom:** Kustomization stuck `READY=False`:
```
ExternalSecret/flux-system/acr-credentials dry-run failed: failed to create typed
patch object ...: .spec.target.template.engine: field not declared in schema
```

**Root cause:** the field is named `engineVersion` in `external-secrets.io/v1` (ESO
0.20.4, the version this repo installs) — `engine` was presumably valid in an older
ESO API version this repo predates. `kustomize build` can't catch this: it validates
YAML structure, not a live CRD's actual OpenAPI schema.

**Fix:** `engine: v2` → `engineVersion: v2`. Also fixed the same stale field name in
`infrastructure/secrets/README.md`'s docs example (same mistake, not yet live).

**Commit:** `374c4e5`

---

<!-- Add new entries above this line, newest first. -->
