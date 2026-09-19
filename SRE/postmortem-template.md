<!--
Postmortem template for an SLO burn-rate incident. Fill this in on the auto-opened
GitHub Issue (see .github/workflows/slo-incident-ticketing.yml) once the incident is
mitigated, then copy the filled-in version into PR-README.md — this repo's existing,
authoritative "every real problem hit on a live cluster" log — so it lives alongside
every other real issue this project has hit, not in a separate place.
-->

## Postmortem

**Detected:** <timestamp> — `<alertname>` (severity=page) fired, auto-opened this issue.

**Budget impact:** <e.g. "consumed ~40 of the 150-request 30-day budget
(see SRE/01-slis-and-slos.md) in 12 minutes before mitigation">.

**What broke:** <plain description, no jargon — what a user or on-call engineer
actually observed>.

**Root cause:** <the actual cause, not just the symptom that triggered the alert>.

**Mitigation (stopped the bleeding):** <what was done immediately — e.g. rollback via
the root README's "Rollback" section, scaling something up, reverting a config>.

**Fix (prevents recurrence):** <the real fix, and its commit/PR — or "none yet,
tracked separately" if the mitigation was a stopgap>.

**Time to mitigate:** <alert fired → bleeding stopped>.
**Time to resolve:** <alert fired → root-caused and fixed for good>.

**Did the deployment gate block a bad promotion during this incident?**
<yes/no/not applicable — SRE/04-deployment-gating.md's gate is documentation-only as
of this writing, not yet wired into `promote-prod.yml`; note whether having it live
would have helped here, since that's the actual argument for building it>.

**What would have caught this sooner?** <a missing alert, a missing SLI, a gap in
this runbook — be specific, and open a follow-up issue/PR if there's a real action
item>.
