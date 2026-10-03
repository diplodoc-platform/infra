# Dependency Automation Stabilization

This runbook records the safety switches that intentionally remain disabled
while testpack and dependency distribution are being stabilized. Do not treat
them as dead code or remove the guards without completing the activation gates
below.

## Current stabilization state

| Mechanism                   | Current behavior                            | Deliberately disabled                              |
| --------------------------- | ------------------------------------------- | -------------------------------------------------- |
| Dependency auto-merge audit | Manual dispatch, audit-only                 | Schedule, live merge, issue publication by default |
| Dependency health audit     | Manual dispatch, `dry_run: true` by default | Weekday schedule, issue creation, owner assignment |
| CI gate synchronization     | Manual dispatch, `dry_run: true` by default | Weekly schedule, ruleset create/update             |
| Infrastructure distribution | Release/manual PR creation                  | Auto-approval and auto-merge (`auto_merge: false`) |

The stable GitHub release event still starts infrastructure distribution for
all configured repositories. Do not publish the stable release until the
prerelease pilots below have passed.

## Required evidence before activation

1. Merge the reviewed testpack helpers into `master` before distributing infra
   callers. By the owner's decision, the reusable caller uses `@master` and
   Actions use version tags, not commit hashes. A new run can pick up a newer
   reviewed workflow; within that run its tools use the resolved workflow SHA.
   Keep the separately pinned trusted policy/publisher source commit available
   on GitHub, including after a squash merge.
2. Observe green testpack `master` Quality runs on Ubuntu, macOS, and Windows.
3. Run the reusable downstream check against exact candidate SHAs for at least:
   - a light extension update such as `tabs-extension` with
     `document-transform`;
   - a parser/transform update such as `transform` with
     `document-rendering`;
   - a grouped production update in `cli` with `ecosystem`.
4. Inspect the uploaded HTML and Markdown corpus comparisons. Do not approve
   unexplained rendering or asset differences by updating expected artifacts.
5. Run the dependency auto-merge and health workflows manually in dry-run mode
   and inspect their JSON and Markdown artifacts.
6. Run CI gate synchronization in dry-run mode for one pilot repository. Verify
   that jobs with `paths` filters or job-level `if` conditions cannot become
   permanently required when GitHub legitimately skips them.
7. Publish an infra prerelease from a simple branch name and distribute it to
   `tabs-extension`, then `transform`, one target at a time. Generated PRs must
   remain unmerged; verify their diffs and CI before closing the pilots.
8. Confirm the GitHub App permissions and create the labels used by mutating
   reporting before enabling publication: `dependency-health`, `summary`,
   `sla-breach`, and `auto-merge`.

## Activation order

Enable one capability per reviewed pull request so each step has an independent
rollback point:

1. Allow optional tracking-issue publication on manual audit runs.
2. Run dependency health manually with `dry_run: false` and verify issue and
   assignment behavior on real data.
3. Apply CI gate synchronization to one pilot repository only. Recheck both a
   dependency PR and an unrelated PR before expanding the target set.
4. Restore the dependency health schedule only after several clean manual runs.
   The previous proposed cadence was weekdays at `07:00 UTC`.
5. Restore the CI gate schedule only after all conditional-context defects are
   fixed. The previous cadence was Monday at `06:00 UTC`.
6. Publish the stable infra release and distribute to all targets. Merge the
   generated PRs in waves, with core packages (`components`, `transform`,
   `cli`) last.
7. Consider live auto-merge only after the full observation period. Restore its
   live execution path and schedule in a separate reviewed change; the current
   workflow cannot pass `--enabled`. The original proposal was a 4–6 week
   observation period with a 24-hour CI soak requirement.

## Security hardening and accepted risk (2026-09-30)

- Policy classification/enforcement reads tooling and the registry from a
  reviewed immutable infra SHA under `trusted-infra`. It never installs or
  executes PR dependencies. A policy update must deliberately refresh that SHA
  after review; do not resolve policy code from candidate `node_modules`.
- The decision schema checks boolean/count consistency, allowed profiles/risks
  and exact head SHA. An unknown profile is an error, not a skipped deep check.
- Required checks bind context, publisher App ID and exact head SHA. Only
  `success` qualifies for future auto-merge; `neutral`, `skipped`, missing and
  unknown publisher evidence block it. The native GitHub Actions publisher is
  App ID 15368. Ruleset sync preserves unrelated rules and manual settings.
  Validate a pilot publisher binding before applying it broadly; external
  status-only integrations require their own reviewed handling.
- Future auto-merge derives section/version/added package identities from full
  base/head manifests and lockfiles at immutable SHAs. Missing/truncated API
  data, unsupported lock formats, multiple direct updates, nondependency manifest
  changes and inconsistent lock roots fail closed. Audit-only remains mandatory.
- Risk comments check the current open PR head twice and edit only their own
  stable marker. Artifacts remain untrusted text; no candidate code is executed.
- Privileged workflows use official Actions directly. Tool installation does
  not run dependency lifecycle scripts.
- Local `infra sync --target ... --dry-run` previews a copy of the dirty working
  tree. It never resets/cleans the source. Symlink-containing targets fail safely;
  remote previews use unique temporary roots, not a caller-owned cleanup folder.

The owner explicitly accepted the App installation-token permission breadth
(security-review item 5). This change does not narrow App permissions/repository
scope or split read/write tokens. Record that residual risk when activating any
future scheduled or mutating path. All schedules, live auto-merge and automatic
distribution approval remain disabled. Do not publish a stable infra release as
part of these security fixes.

Local validation for this hardening: 650 unit tests and 17 integration tests
passed, along with lint, JavaScript syntax checks, package build and workflow
actionlint validation (without shellcheck). Testpack's focused repository suite
passed 156 tests with 2 existing skips. Hosted isolated-job pilots are still
pending publication of the reviewed commits. Replaying saved corpus artifacts
with the strengthened comparator found seven previously excluded client JS/CSS
changes, including OpenAPI layout changes; review those differences before
treating that candidate as approved. Components and search corpus replays passed.

## Workflow readability and version policy (2026-10-03)

The owner requested version tags for Actions and `@master` for the reusable
testpack caller. Tags and branches are mutable: this accepts the residual risk
that their contents can change without a diff in this repository. A major tag
is not a guarantee of compatibility. Do not silently reintroduce Action SHA
pins; keep exact candidate, policy and comparison source revisions intact.

Large JavaScript blocks now live in independently tested modules:
`scripts/dependency-verification-decision.js` exports validated classifier
outputs, and `scripts/publish-dependency-risk-comment.js` publishes only a
current, correctly bound artifact to its own marked comment. The privileged
publisher checks out a reviewed immutable infra revision separately from the
artifact; it never loads code from the PR or the artifact. Root and distributed
comment workflows use the same publisher implementation.

`scripts/workflows/` also contains the health/auto-merge summaries, PAT rotation
alert and CI-gate/distribution report adapters. YAML passes the GitHub clients
to these modules in two lines. Report-only jobs explicitly check out their own
workflow revision before reading status artifacts. Adapter tests use mocked
files and APIs; they do not publish issues or change rulesets.

Removing the npm cache remains intentional: baseline and candidate must not
share a cache populated by candidate lifecycle scripts. The cost is a slower
clean install, not a change to the dependency versions under test.

Follow-up validation (2026-10-03): 658 unit tests and 17 integration tests passed,
as did lint, syntax checks, package build, normal pre-commit hooks and actionlint
1.7.12 (without shellcheck). The npm package contains all extracted adapters.
Hosted reusable pilots, release/distribution and live ruleset checks are still
separate activation gates, not claimed by these local results.

## Rollback

- Remove or disable the newly restored schedule first.
- Set distribution `defaults.auto_merge` back to `false` before changing any
  individual repository overrides.
- Revert ruleset changes on the pilot repository before expanding CI gate
  synchronization.
- Revert already merged dependency updates through reviewed pull requests; do
  not force-push protected default branches.

Keep this runbook linked from `AGENTS.md` and update it whenever an activation
gate is completed or a proposed cadence changes.
