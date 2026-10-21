# Dependency candidate preparation

GitHub prepares one immutable temporary CLI PR from selected Dependabot updates.
It does not access private CI/review APIs, hold internal OAuth credentials, send
notifications, observe document checks, merge PRs or publish npm packages.

## Trust boundary

1. Select dependency-only, non-critical patch/minor updates with green exact-head
   required checks and explicit publisher bindings. New/removed dependencies,
   major updates, unknown evidence and ignored changes fail closed.
2. Freeze infrastructure, metapackage, CLI base and source SHAs. Rebuild affected
   consumers, including client assets for component changes.
3. Build/pack without secrets. Relocatable archives and scoped overrides carry
   source lock versions. Verify installed identities, run CLI tests/typecheck and
   HTML/Markdown smoke builds. Do not update baselines.
   Resolution proof paths describe runtime dependency chains, not physical
   lockfile directories. Resolve each edge from its installed parent and require
   its exact source-lock version, including peer dependencies and cycle-closing
   edges. Optional branches may be absent; present versions must still match.
4. On a fresh publisher, independently validate data against canonical source
   locks. Use the existing CLI-scoped App token and contributor bot credential to
   open one immutable CLI candidate. Never execute candidate code in this job.
5. Stop at **prepared, not verified**. The existing internal webhook prepares its
   Internal check. Hand off the CLI PR number, full head SHA and infrastructure
   tooling SHA to the separately reviewed internal operations observer.

Internal observation belongs to Viewer operations. Internal API credentials,
endpoints, review links, CA configuration and notification credentials stay
inside the internal infrastructure and its existing secret/notification system.
They must not be configured in GitHub Actions. The observer reads frozen public
candidate data, independently checks installed-version proof and exact document
results, and reports through the existing internal notification transport.
Missing proof, skipped checks or a stale SHA/diff cannot count as success.

## Manual pilot without enabling a schedule

Dispatch `dependency-candidate-train.yml` with:

- `repositories: tabs-extension`;
- `pr_number: 160` (or a separately approved exact open Dependabot PR);
- `dry_run: true` for selection only, the default.

After inspecting that exact selection, `dry_run: false` explicitly approves
one preparation run. This does not require changing an organization variable.
Selection/build jobs have no secrets. Publication uses only existing GitHub
credentials (`INFRA_APP_ID`, `INFRA_APP_PRIVATE_KEY`, `INFRA_APPROVER_PAT`).
The public summary and `train-candidate.json` contain only public identities;
they never claim successful Internal verification.

Start the internal observer manually after preparation, using the three frozen
handoff values. The operator still presses the document CI button when notified.
Nothing merges the candidate or source PR. Close the temporary CLI PR without
merge after inspecting the result; a still-needed timed-out candidate may remain
open for an explicitly resumed observation. A new train has a new immutable plan.

## Future scheduled preparation (still disabled)

`DEPENDENCY_CANDIDATE_TRAIN_ENABLED` absent/false disables scheduled preparation.
The retained future cron is 06:17 Europe/Moscow, targeting readiness by 08:00;
GitHub scheduling is not an SLA. `DEPENDENCY_TRAIN_REPOSITORIES` is an explicit
1–3 repository allowlist. Repository variables in infra override organization
values; variables in source repositories do not control this central workflow.

Do not enable scheduled preparation before the internal handoff and one full
manual pilot have passed. This change does not enable it. Internal observation
also has no schedule. Health audits, distribution and auto-merge are independent
gates and remain unchanged. Turning off a schedule flag does not cancel already
running jobs or an existing Internal check.
