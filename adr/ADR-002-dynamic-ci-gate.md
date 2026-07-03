# ADR-002: Dynamic per-repo CI gate, PAT-expiry monitoring, bot-PR auto-approval

## Status

Accepted

## Context

[ADR-001](ADR-001-infra-distribution-pipeline.md) established the distribution
pipeline and two Rulesets per target repo. Ruleset A — `master CI gate` —
enforces `required_status_checks` and is the thing GitHub auto-merge actually
waits on.

That ruleset was set up **by hand** on GitHub with a single, flat, org-wide list
of common checks (`test (...)` on three OSes). That was a deliberate first step:
a minimal shared list to get _some_ enforced check in front of auto-merge across
all repos, with the intent to refine the mechanism later. This ADR is that
refinement.

Two limitations of the static list:

- **It is flat.** Repos with custom workflows (e.g. `cli`) have checks the gate
  does not know about, so auto-merge only waits for the common subset.
- **It is manual.** Any CI change (new workflow, changed matrix) requires
  editing the ruleset by hand in every repo, and the list drifts from reality.

We also still carry two open items from ADR-001 "Future work" / operational
needs:

- the `INFRA_APPROVER_PAT` (machine user `diplodoc-bot`) must be rotated before
  it expires, and nothing watches that today;
- automated bot PRs (dependency updates, release PRs) still need a human (or the
  machine user) to approve them, even though the change is mechanical.

## Decision

### 1. Discover the required checks per repo, don't hardcode them

A new tool computes, **per repo**, the actual set of CI status-check contexts and
points `master CI gate` at exactly that set.

- Source of truth: **workflow YAML files** on the default branch. For each workflow
  that runs on `pull_request`, job names are derived (`job.name` or job id) and
  `strategy.matrix` is expanded to `base (v1, v2, ...)` over the cartesian product
  of its array dimensions. This is stable and predictable; it does not pick up
  one-off check-runs from the latest commit (Dependabot, deploy jobs, etc.).
- **Commit-based discovery is disabled** for now (`GET .../check-runs` on default-
  branch HEAD was too noisy). The code is kept commented-out in
  `sync-ci-gate.js` for a possible future re-enable (e.g. reading checks from a
  merged PR instead of HEAD).
- A glob exclude list (`ci_gate.exclude_checks` in `distribution.yml`, merged with
  per-repo patterns) removes checks that must **not** gate a PR (conditional /
  non-PR workflows like `Test coverage` (continue-on-error), `SonarCloud`,
  `release-please`, `update-deps`, `Publish*`, `Dependabot*`, repo-specific jobs
  like `deploy`). **`Update package-lock.json` is intentionally kept** — it runs
  on every in-repo PR. Note the glob is case-sensitive and anchored, so
  `Test coverage` needs `*coverage*` (not `coverage*`).
- The result is written to the ruleset via the Rulesets API: find the ruleset by
  name and `PUT` it, or `POST` a new one if missing. The operation is
  **idempotent** — re-running just rewrites the contexts.
  - Caveat: the parser does **not** evaluate job-level `if:`. A job that is
    present but skipped on PRs (e.g. a `Publish to npm` job gated by
    `if: github.event_name == 'push'`) would otherwise be added as a required
    check that never reports and deadlocks PRs. Such names are dropped via the
    exclude list (`Publish*`).

### 1b. Also ensure the check-independent protection gate (Ruleset B)

The same sync now also guarantees Ruleset B — `master protection (auto-merge via
app)` (review + merge policy, ADR-001). Unlike the CI gate, it is **create-only**:
if a ruleset with that name already exists it is left untouched (manual tweaks are
preserved); only when it is missing (e.g. a freshly created repo) is it created
from `protection_gate` in `distribution.yml` (`required_approving_review_count`,
`require_code_owner_review`, `deletion`, `non_fast_forward`, allowed merge methods).
The distribution App (`INFRA_APP_ID`) is added as an `Integration` bypass actor
when its id is available, matching the hand-made rulesets on existing repos.

Implementation:

- [`scripts/sync-ci-gate.js`](../scripts/sync-ci-gate.js) — discovery + filter +
  create/update, with pure helpers covered by
  [`test/unit/sync-ci-gate.test.js`](../test/unit/sync-ci-gate.test.js).
- CLI: `infra gate sync --repo <name>|--all [--dry-run] [--config <path>] [--output <file>]`
  (see [`bin/infra.js`](../bin/infra.js)).
- Workflow: [`.github/workflows/sync-ci-gate.yml`](../.github/workflows/sync-ci-gate.yml)
  — `prepare` → `sync` (matrix × repos) → `report`. Triggers:
  - `workflow_dispatch` (`target` = repo name or `all`) — manual / targeted;
  - `schedule` (weekly `0 6 * * 1`, Monday 06:00 UTC) — new workflows appear
    rarely; idempotency makes repeated runs safe.

Only **Ruleset A** is managed as code here. Ruleset B (review / merge policy)
stays as configured per ADR-001.

### 2. Extend the distribution App with `Administration: write`

The Rulesets API requires repository `Administration: write`. The existing
GitHub App `diplodoc-infra` (used by the distribution pipeline) is extended with
that permission; `sync-ci-gate.yml` mints a per-repo installation token via
`actions/create-github-app-token@v1`. No new identity is introduced.

This is a **manual GitHub configuration step** (there is no API for it): in the
App settings add `Repository permissions → Administration: Read and write` and
re-approve the permission on the target repos. Without it the `PUT/POST
.../rulesets` calls return `403`.

### 3. Monitor `INFRA_APPROVER_PAT` expiry (remaining ADR-001 item)

GitHub provides **no API to create or regenerate a fine-grained PAT**, so the
PAT cannot be auto-rotated. Switching the approver to a GitHub App token is also
**not** an option: an App cannot be a code owner and cannot approve PRs — the
exact reason the PAT exists (ADR-001 §3, alternatives C and E). Therefore the
realistic automation is detection + ahead-of-time alerting:

- [`scripts/check-pat-expiry.js`](../scripts/check-pat-expiry.js) — lists org
  PAT grants (`GET /orgs/{org}/personal-access-tokens`), finds the
  `diplodoc-bot` token, computes days to expiry. Pure helpers tested in
  [`test/unit/check-pat-expiry.test.js`](../test/unit/check-pat-expiry.test.js).
- [`.github/workflows/check-pat-expiry.yml`](../.github/workflows/check-pat-expiry.yml)
  — `workflow_dispatch` plus **two scheduled reminders** instead of a daily run:
  one ~2 weeks before and one ~3 days before the current PAT expiry. The `cron`
  dates are relative to the current expiry and must be updated on each rotation.
  On `warn` (≤ 14 days), `expired`, `missing` or `error` it opens/updates a
  `pat-rotation` tracking issue, **assigns it to the `@diplodoc-platform/team`
  members and @mentions the team**, and annotates the run; `expired` / `missing`
  / `error` also fail the run.

Rotation itself remains the manual runbook in ADR-001 (Operational Notes). This
requires the App to have the org permissions **"Personal access tokens: read"**
(to list tokens) and **"Members: read"** (to resolve team members for issue
assignment; assignment is best-effort and falls back to the team @mention).

### 4. Auto-approve automated bot PRs with the machine user

Two kinds of automated PRs are mechanically generated and should be approved by
`diplodoc-bot` without a human:

- dependency updates from [`scaffolding/.github/workflows/update-deps.yml`](../scaffolding/.github/workflows/update-deps.yml)
  (author `yc-ui-bot`, branch `ci/update-deps/*`);
- release PRs from [`scaffolding/.github/workflows/release-please.yml`](../scaffolding/.github/workflows/release-please.yml)
  (author `yc-ui-bot`, branch `release-please--*`).

The PR author (`yc-ui-bot`) differs from the approver (`diplodoc-bot`), so
GitHub's no-self-approval rule is not violated.

- [`scaffolding/.github/workflows/auto-approve.yml`](../scaffolding/.github/workflows/auto-approve.yml)
  — distributed to every repo. Triggers on `pull_request` (not
  `pull_request_target`, and it never checks out PR code), so fork PRs get no
  secrets. A declarative `if:` gate matches author + branch, then — as defense in
  depth — it verifies **every commit on the PR was authored and committed by
  `yc-ui-bot`** before approving via `INFRA_APPROVER_PAT`. This ties the approval
  to bot-generated content, so a push by someone else to a `ci/update-deps/*` /
  `release-please--*` branch does not earn a free code-owner approval. On every
  push (`synchronize`) a prior bot approval made for an older commit is
  **dismissed** so an approval never lingers over unreviewed new code; a fresh
  approval is re-issued only when the new head is still all-bot content. It is
  idempotent (skips if the current head is already approved) and **does not**
  enable auto-merge — the CI gate from decision 1 must still pass.
- [`scripts/match-auto-approve.js`](../scripts/match-auto-approve.js) — the
  canonical, unit-tested matcher
  ([`test/unit/match-auto-approve.test.js`](../test/unit/match-auto-approve.test.js)).
  The scaffolding workflow mirrors these rules; keep the two in sync.

Per-repo opt-out reuses the existing blacklist mechanism: exclude
`.github/workflows/auto-approve.yml` via `.infrarc.yml` or `distribution.yml`.

## Consequences

### Positive

- The CI gate reflects each repo's **declared** PR workflows and self-heals weekly.
- No more hand-editing rulesets across repos.
- PAT expiry is surfaced ahead of time instead of failing the pipeline.
- Mechanical bot PRs no longer wait on a human approval.

### Negative

- The App now has `Administration: write` — a broader permission; scoped to the
  same distribution identity but worth noting in audits.
- The matcher logic lives in two places (tested script + scaffolding `if:`) and
  must be kept in sync.
- Workflow parsing does not evaluate job-level `if:`; the exclude list handles
  jobs that exist in YAML but skip on PRs. See "Notes".

### Neutral

- `strict_required_status_checks_policy: false` is preserved (no forced
  "branch up to date").

## Notes / risks

- Workflow parsing is best-effort: it does not expand `matrix.include` / `exclude`,
  cannot resolve `${{ }}` expressions in names, and does not model reusable-
  workflow (`uses:`) job naming or job-level `if:`. Wrong guesses are dropped via
  `exclude_checks` (global + per-repo merge). Our own scaffolding (`tests.yml`,
  `security.yml`, `package-lock.yml`) is expanded exactly. The matrix expansion is
  capped (`MAX_MATRIX_COMBINATIONS`) so a pathological matrix cannot explode the
  sync job; oversized matrices degrade to the bare job name.
- Commit-based discovery (default-branch HEAD check-runs) is **disabled** — it
  picked up Dependabot and other one-off statuses. Possible future re-enable:
  read checks from the latest merged PR instead of HEAD.
- If workflow parsing yields zero contexts after filtering, the sync **skips**
  that repo rather than installing an empty (no-op) gate.

### Residual risk: commit-author check vs. email spoofing

The auto-approve content check trusts GitHub's `author.login` / `committer.login`,
which GitHub derives from the commit's **email**. The bot's email is the public
noreply address, and `update-deps` commits are plain `git commit` pushes (not
GPG-signed / `verified`). So a **repo collaborator with write access** could push
a commit to a `ci/update-deps/*` / `release-please--*` branch with that email
spoofed and defeat the content check. Mitigating factors and options:

- The PR **author** (`pull_request.user.login`) cannot be spoofed by email — only
  the real `yc-ui-bot` can open the qualifying PR — so this is strictly an
  _insider-with-write-access_ threat, not an external one. Fork PRs get no secrets.
- This workflow only **approves**; it does not enable auto-merge, and the CI gate
  must still pass. A subsequent `synchronize` also dismisses stale approvals.
- Stronger fix (deferred): require `commit.verification.verified === true`. That
  would need `update-deps` to sign its commits (or create them via the GitHub API,
  which auto-signs), otherwise legit dep PRs would stop being approved. Complementary:
  restrict push to bot branches to the bot via branch protection.
- Approvals are pinned to the validated head SHA and only issued when the commit
  list still ends at the exact SHA from the triggering event (TOCTOU guard).

## Related Documents

- [ADR-001](ADR-001-infra-distribution-pipeline.md) — distribution pipeline and
  the two-Ruleset design this builds on.
- [`devops/infra/AGENTS.md`](../AGENTS.md) — operational reference.
