# Dependency candidate preparation

GitHub prepares one immutable temporary CLI PR per selected wave of Dependabot updates.
It does not access private CI/review APIs, hold internal OAuth credentials, send
notifications, observe document checks, merge PRs or publish npm packages.

## Supported repositories and waves

`DEPENDENCY_TRAIN_REPOSITORIES=all` inventories registered packages under
`packages/` and `extensions/` using the explicit build model in
`scripts/candidate-train/model.js`. The current metapackage has 25 registered
packages/extensions: **23 are supported; direct CLI and VSC updates remain
excluded**. This is not every organization repository or every npm dependency.
Infrastructure-only repositories require their own verification paths.
An explicit comma-separated allowlist remains valid without the old
three-repository limit.

The model includes ordinary runtime dependencies, client asset build inputs,
and six packages bundled or copied during CLI build: latex, mermaid, openapi,
page-constructor, search and yfmlint. It does not treat every development tool
as a shipped dependency. The model also declares four opt-in integration roots:
algolia, folding-headings, html and quote-link. Only selected opt-ins add virtual
CLI edges and exact candidate-only archive dependencies; other waves do not
silently acquire these extensions. Canonical source manifests remain unchanged.

Only **low policy-risk** patch/minor updates qualify. This is output-impact risk,
not CVSS; a patch or minor is not automatically low risk. Other risks and
major/new/removed/ignored changes need separate review. Current master bases,
green exact-head required checks and publisher bindings remain mandatory.

All eligible PRs are ordered by creation time, repository and PR number. Waves
contain at most three PRs and at most one PR per repository. `train-plan.json`
records the complete eligible/excluded inventory; the summary limits long lists
to 100 waves/exclusions and points to that artifact. More than 2,000 considered
PRs is an explicit error, not a silently partial inventory.

## Trust boundary

1. Select dependency-only, low-risk patch/minor updates with green exact-head
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
   Independently compare logical dependency chains with the frozen CLI lock,
   including CLI tooling dependencies. Unselected consumer package versions and
   registry identities, dependency edges and resolutions may not drift merely
   because an archive was rebuilt. Hoisting alone is not a version change.
   Only selected, model-declared opt-in roots may add an exact archive dependency;
   their subtrees must still match canonical source locks.
   Incompatible or ambiguous source locks require an explicit baseline refresh;
   never replace versions while claiming the original schema 1 source-lock proof.
4. On a fresh publisher, independently validate the dependency delta and data against canonical source
   locks. Use the existing CLI-scoped App token and contributor bot credential to
   open one immutable CLI candidate. Never execute candidate code in this job.
5. Stop at **prepared, not verified**. The existing internal webhook prepares its
   Internal check. Hand off the CLI PR number, full head SHA and infrastructure
   tooling SHA to the separately reviewed internal operations observer.

## Opt-in activation coverage

An installed archive is not proof that its feature ran. Preparation builds
separate temporary HTML and Markdown configurations for each selected opt-in.
All selected archives remain installed in the same candidate CLI. Checks require
folding sections, quote-link blocks, sandboxed HTML
iframes, or Algolia provider/local search artifacts as appropriate. Runtime
assets must be attached and match bytes from the installed candidate package.
Algolia smoke does not upload an index: inherited Algolia settings are cleared,
index upload is disabled and the CLI subprocess has a network guard.

Successful fixture checks are recorded separately in `proof.integrations` with
scope `generated-fixture`. The publisher requires the exact selected coverage.
The schema 1 `resolutions` field retains its runtime-chain meaning. Fixtures,
adapters and temporary host links are not published into the CLI source tree.

These checks do not force opt-ins into arbitrary internal documents. That corpus
uses its own configuration; a green generated fixture does not certify a feature
inside every internal document. A full manual downstream pilot remains required
for the expanded build model before relying on its Internal Check handoff.

Published-package probes on 2026-10-28 passed Algolia 0.7.2, folding-headings
0.2.5 and quote-link 0.1.8 against CLI 5.64.0. HTML 2.9.14 fails its default
srcdoc scenario because the CLI's outer sanitizer removes iframe content. The
train retains this failure; it does not disable sanitization to obtain success.
Package support means a runnable check, not a guarantee of a passing baseline.

Independent fixtures do not certify same-page composition. A separate published
folding-headings + quote-link probe found a shared runtime-copy cache key that
drops quote-link assets. Neither existing package integration defect is repaired
by the infrastructure build model.

Internal observation belongs to Viewer operations. Internal API credentials,
endpoints, review links, CA configuration and notification credentials stay
inside the internal infrastructure and its existing secret/notification system.
They must not be configured in GitHub Actions. The observer reads frozen public
candidate data, independently checks installed-version proof and exact document
results, and reports through the existing internal notification transport.
Missing proof, skipped checks or a stale SHA/diff cannot count as success.

## Manual waves without enabling a schedule

Dispatch `dependency-candidate-train.yml` with:

- `repositories: all` (or empty to use the organization variable);
- `pr_number: 0` for automatic selection;
- `wave: 1`;
- `dry_run: true` for selection only, the default.

After inspecting that exact selection, `dry_run: false` explicitly approves
one preparation of the selected wave. This does not require changing an organization variable.
With one explicitly named repository, `pr_number` can select an exact open
Dependabot PR. An open temporary CLI candidate is reported before heavy build
and prevents another preparation, without closing or certifying the existing PR.
The publisher repeats the final race check before creating a new candidate.
Selection/build jobs have no secrets. Publication uses only existing GitHub
credentials (`INFRA_APP_ID`, `INFRA_APP_PRIVATE_KEY`, `INFRA_APPROVER_PAT`).
The public summary and `train-candidate.json` contain only public identities;
they never claim successful Internal verification.

Start the internal observer manually after preparation, using the three frozen
handoff values. The operator still presses the document CI button when notified.
Nothing merges the candidate or source PR. Close the temporary CLI PR without
merge after inspecting the result; a still-needed timed-out candidate may remain
open for an explicitly resumed observation. A new train has a new immutable plan.

Each wave is an **independent candidate**, not cumulative validation of earlier
waves. `wave: 2` tests only that wave. After verification, separately merge
approved source PRs, refresh remaining Dependabot bases/CI and run a new dry-run.
Typically continue with wave 1 of the new inventory: wave numbers can change
after merges or source-head updates. Nothing automatically advances or merges.

For example, rebuilding translation for a tabs update must not silently carry
`js-yaml@4.1.1` or downgrade unrelated dependencies. A mismatch with the frozen
CLI baseline blocks preparation; this change does not repair source lockfiles
or hide existing baseline vulnerabilities. Dependency review remains required.

## Scheduled preparation controls

`DEPENDENCY_CANDIDATE_TRAIN_ENABLED` absent/false disables scheduled preparation.
The retained cron is 06:17 Europe/Moscow, targeting readiness by 08:00;
GitHub scheduling is not an SLA. `DEPENDENCY_TRAIN_REPOSITORIES` is an explicit
repository allowlist or `all`. Scheduled preparation selects wave 1; other waves
are explicitly selected on manual dispatch. No new organization variable is
needed. Repository variables in infra override organization
values; variables in source repositories do not control this central workflow.

Do not enable scheduled preparation before the internal handoff and one full
manual pilot have passed. This change does not enable it. Internal observation
also has no schedule. Health audits, distribution and auto-merge are independent
gates and remain unchanged. Turning off a schedule flag does not cancel already
running jobs or an existing Internal check.

The 08:00 readiness timestamp is metadata, not a deadline guarantee. This change
does not alter the cron, add an external dispatcher, or enable any automation.
