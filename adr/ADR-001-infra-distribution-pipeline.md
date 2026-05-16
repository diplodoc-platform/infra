# ADR-001: Infra Scaffolding Distribution Pipeline

## Status

Accepted

## Context

The `@diplodoc/infra` package owns a shared scaffolding (CI workflows, lint
configs, `CODEOWNERS`, `tsconfig` bases, release tooling, etc.) that must be
kept in sync across **26 target repositories** in the `diplodoc-platform`
organization. The scaffolding is consumed by copying its files into the root of
each target repo on every release of `@diplodoc/infra`.

Manual propagation does not scale:

- Updating 26 repos by hand on every release is error-prone and slow.
- Drift between repos accumulates silently and breaks CI in unexpected places.
- Security-sensitive changes (workflow permissions, pinned action versions)
  must roll out atomically.

We therefore need an **automated distribution pipeline** that, on every stable
release of `@diplodoc/infra`, opens a PR against each target repo with the new
scaffolding, runs CI, and merges the PR if green.

## Problem

A naive design — "GitHub App opens PR + enables auto-merge" — turned out to be
insufficient because of three independent GitHub limitations that we hit one
after another during rollout:

### 1. `bypass_actors` does not satisfy auto-merge prerequisites

GitHub Rulesets allow listing actors that can bypass the rules. This works for
**direct merges** through the API, but **auto-merge queues** wait for the rules
to be *actually* satisfied — they do not consult `bypass_actors`. As a result,
PRs opened by the App with `auto_merge` enabled stayed in `BLOCKED` state even
though the App was in `bypass_actors`.

### 2. CI gate was bypassed together with PR rules

When all protection rules live in a single Ruleset and the App is in
`bypass_actors`, the App bypasses **every rule at once**, including
`required_status_checks`. During the first rollout this caused **24 PRs to be
merged without CI ever running**. We need CI to be enforced for the
distribution App while still allowing it to satisfy review requirements.

### 3. GitHub Apps cannot be code owners

`CODEOWNERS` only accepts `@user` and `@org/team` entries. A GitHub App
identity (`app/<slug>`) is **not** a valid code owner. Therefore a PR rule with
`require_code_owner_review: true` cannot be satisfied by an App review, even if
the App's review is otherwise counted toward `required_approving_review_count`.

In addition, GitHub forbids **self-approval**: the actor that opens a PR cannot
approve it. So a single identity cannot both open and approve PRs.

## Decision

We adopt a **three-job workflow** driven by **two distinct actors** and **two
separate Rulesets** on every target repo.

### Workflow shape (`distribute-infra.yml`)

Three jobs, executed on `release: published` (stable only) or manual
`workflow_dispatch`:

```
prepare ──▶ distribute (matrix: 26 repos) ──▶ report
```

1. **`prepare`** — resolves the `@diplodoc/infra` version to distribute and
   waits for it to appear on npm (`npm view @diplodoc/infra@<v>`, polled up to
   60 × 10 s = 10 min). This decouples the GitHub release event from npm
   propagation latency.
2. **`distribute`** — a matrix job over all 26 targets. For each repo it
   clones, syncs the scaffolding, computes a diff, pushes a branch, opens a
   PR, enables auto-merge, and triggers an auto-approve. Each shard writes a
   thin `status-<repo>.json` artifact.
3. **`report`** — downloads all `status-*` artifacts, polls each open PR for
   up to 24 × 5 s to capture honest `mergeStateStatus`, renders a Markdown
   table into `$GITHUB_STEP_SUMMARY` with notice/warning/error annotations,
   and calls `core.setFailed()` if any shard failed.

### Trigger filter — whitelist, not blacklist

```yaml
if: |
  (github.event_name == 'release'
    && github.event.release.prerelease == false
    && github.event.release.draft == false) ||
  github.event_name == 'workflow_dispatch'
```

We explicitly **whitelist** stable releases instead of blacklisting
`prerelease`. New release types added by GitHub in the future will be safely
ignored by default.

### Two Rulesets per target repo

Splitting protection into two Rulesets is the key to satisfying CI **and**
review requirements simultaneously.

#### Ruleset A — `master CI gate`

Enforces CI for everyone, including the distribution App. The only bypass is
`OrganizationAdmin` (for emergency human override).

```jsonc
{
  "name": "master CI gate",
  "enforcement": "active",
  "bypass_actors": [
    { "actor_type": "OrganizationAdmin", "bypass_mode": "always" }
  ],
  "rules": [{
    "type": "required_status_checks",
    "parameters": {
      "strict_required_status_checks_policy": false,
      "required_status_checks": [
        { "context": "test (ubuntu-latest, 22)" },
        { "context": "test (macos-latest, 22)" },
        { "context": "test (windows-latest, 22)" }
      ]
    }
  }]
}
```

#### Ruleset B — `master protection (auto-merge via app)`

Enforces review and merge policy. Bypass includes the distribution App so it
can ship hotfixes via direct merge if ever needed, but auto-merge still must
satisfy the rules with real approvals.

- `pull_request`: `required_approving_review_count: 1`,
  `require_code_owner_review: true`, `dismiss_stale_reviews_on_push: false`,
  `allowed_merge_methods: [rebase, squash]`
- `deletion`, `non_fast_forward`
- bypass: `OrganizationAdmin` + Integration App (`INFRA_APP_ID`)

### Two actors

| Actor | Identity | Role |
|---|---|---|
| **Publisher** | GitHub App `diplodoc-infra` (`INFRA_APP_ID`) | Opens the PR, pushes the branch, enables auto-merge. |
| **Approver** | Machine user `diplodoc-bot`, member of `@diplodoc-platform/team` | Reviews and approves the PR using a fine-grained PAT (`INFRA_APPROVER_PAT`). |

The Approver is a **real GitHub account**, not an App, because:

- It must appear in `CODEOWNERS` (only `@user` / `@org/team` are valid).
- It must satisfy GitHub's no-self-approval rule, so it must be a different
  identity from the Publisher.

The Approver participates by virtue of being a member of
`@diplodoc-platform/team`, which is the wildcard owner in `CODEOWNERS`:

```
* @diplodoc-platform/team
```

### Auto-approve step

```yaml
- name: Auto-approve PR via diplodoc-bot machine user
  if: steps.changes.outputs.has_changes == 'true' && steps.auto-merge.outputs.value == 'true'
  env:
    GH_TOKEN: ${{ secrets.INFRA_APPROVER_PAT }}
    PR_NUMBER: ${{ steps.pr.outputs.pr_number }}
  run: |
    [ -z "${PR_NUMBER}" ] && exit 0
    [ -z "${GH_TOKEN}" ] && exit 0
    gh pr review "${PR_NUMBER}" --repo "${REPO}" --approve --body "..."
```

### End-to-end flow

```
@diplodoc/infra release published
        │
        ▼
prepare: wait for npm publish
        │
        ▼
distribute (matrix × 26):
  clone target ─▶ sync scaffolding ─▶ diff ─▶ branch push
        │
        ├─▶ Publisher App opens PR + enables auto-merge
        │
        └─▶ Approver (diplodoc-bot via PAT) approves PR
                │
                ▼
       CI runs (Ruleset A enforces test × 3 OS)
                │
                ▼
       Auto-merge merges (Ruleset B satisfied by approval)
        │
        ▼
report: poll PR states, render Markdown table
```

## Consequences

### Positive

- Releases of `@diplodoc/infra` propagate to all 26 repos automatically.
- CI gate (`Ruleset A`) protects every default branch from broken scaffolding,
  even for the distribution App.
- `require_code_owner_review` is satisfied through a real code-owner account,
  preserving the same policy for human contributors.
- Honest merge-state polling in `report` makes rollouts auditable.
- Whitelist trigger filter is robust to new GitHub release types.

### Negative

- The fine-grained PAT `INFRA_APPROVER_PAT` must be **manually rotated every
  90 days** — GitHub has no API for PAT creation/rotation.
- A machine user (`diplodoc-bot`) must be maintained: 2FA enabled, kept in
  `@diplodoc-platform/team`, secrets stored organization-wide.
- Two Rulesets per repo doubles the audit surface; both must stay aligned
  across all 26 targets (managed via the same scaffolding).

### Neutral

- The distribution workflow is owner-scoped; granting access to a new repo
  requires updating the matrix list and the PAT's repo selection.

## Alternatives Considered

### A. Single Ruleset with App in `bypass_actors`

**Rejected.** Caused the first incident: the App bypassed all rules including
`required_status_checks`, so 24 PRs merged without CI. Splitting into two
Rulesets fixes this.

### B. Auto-merge with App approval only

**Rejected.** Auto-merge ignores `bypass_actors` when evaluating PR rules. It
demands an actual approval and an actual code-owner approval; App bypass does
not satisfy either.

### C. Add the App to `CODEOWNERS`

**Not possible.** GitHub `CODEOWNERS` syntax does not accept App identities.
Only `@user` and `@org/team` entries are valid.

### D. Drop `require_code_owner_review`

**Rejected.** Code-owner review is a meaningful protection for human-authored
PRs across these repos. Weakening protection org-wide to work around a bot
limitation is not acceptable.

### E. Second GitHub App as approver (`diplodoc-infra-approver`)

**Rejected.** Hits limitation C (App cannot be a code owner). Was briefly
prototyped before discovering the CODEOWNERS restriction.

## Operational Notes

### Required secrets (organization-level)

| Secret | Purpose | Owner |
|---|---|---|
| `INFRA_APP_ID` | Publisher App ID | GitHub App `diplodoc-infra` |
| `INFRA_APP_PRIVATE_KEY` | Publisher App private key | GitHub App `diplodoc-infra` |
| `INFRA_APPROVER_PAT` | Fine-grained PAT for the Approver | Machine user `diplodoc-bot` |

### `INFRA_APPROVER_PAT` configuration

- **Resource owner:** `diplodoc-platform` (NOT personal scope — personal PATs
  cannot access org repos even if the user is a member).
- **Repository access:** all 26 target repos (selected explicitly).
- **Permissions:** `Pull requests: Read and write`.
- **Approval:** an org admin must Approve the token in
  *Organization settings → Personal access tokens → Pending requests*.
- **Lifetime:** 366 days. Rotation procedure:
  1. `diplodoc-bot` logs in, regenerates the PAT with the same scope.
  2. Org admin approves the new token.
  3. Update the `INFRA_APPROVER_PAT` org secret.
  4. Trigger `workflow_dispatch` of `distribute-infra.yml` with `target=all`
     and a no-op version to smoke-test.

### `diplodoc-bot` machine user requirements

- 2FA enabled (org policy).
- Member of `@diplodoc-platform/team`.
- No write permissions beyond what the team grants — the PAT is the only
  privileged surface.

### Future work

- Add `check-pat-expiry.yml` cron workflow polling
  `GET /orgs/{org}/personal-access-tokens` and alerting ≥ 14 days before
  expiry.
- Consider replacing `INFRA_APPROVER_PAT` with a GitHub App once GitHub
  supports Apps in `CODEOWNERS` (tracked upstream).

## Related Documents

- `devops/infra/.github/workflows/distribute-infra.yml` — pipeline implementation.
- `devops/infra/.github/workflows/release.yml` — upstream release workflow.
- `devops/infra/scaffolding/.github/CODEOWNERS` — code-owner template distributed to targets.
