# Dependency automation controls

These controls govern the existing central audit workflows in `infra`. They do
not publish packages, distribute infrastructure, merge dependency PRs, or build
a nightly CLI candidate. No variable needs to be created for this change:
missing variables leave all scheduled audit jobs disabled.

## Switches and cadence

Create configuration variables under **Organization settings > Secrets and
variables > Actions > Variables**, granting access to `infra`. They are not
secrets. Use the strings `true` and `false` consistently.

| Variable                             | Effect when `true`                                                 |
| ------------------------------------ | ------------------------------------------------------------------ |
| `DEPENDENCY_SCHEDULES_ENABLED`       | Allows the per-audit switches below to take effect                 |
| `DEPENDENCY_HEALTH_ENABLED`          | Allows the nightly dependency health audit                         |
| `DEPENDENCY_AUTOMERGE_AUDIT_ENABLED` | Allows the nightly eligibility audit; never enables merging        |
| `DEPENDENCY_CI_GATE_AUDIT_ENABLED`   | Allows the weekly CI-gate discovery report; never changes rulesets |

Every scheduled entry job requires both `DEPENDENCY_SCHEDULES_ENABLED` and its
own switch to equal `'true'`. Missing or `false` values disable the job before
checkout, dependency installation, or App-token creation. Actions string
comparisons are case-insensitive; do not use other spellings as a safety guard.

| Audit                  | Cron (UTC)   | Europe/Moscow   |
| ---------------------- | ------------ | --------------- |
| Dependency health      | `17 0 * * *` | Daily at 03:17  |
| Auto-merge eligibility | `47 0 * * *` | Daily at 03:47  |
| CI-gate discovery      | `23 1 * * 1` | Monday at 04:23 |

The fixed schedule declarations remain in YAML. With switches off, GitHub can
still show skipped workflow runs, but the audit jobs do not consume runners.
Changing a switch affects future job evaluations; it does not cancel an
already-running workflow. Cancel such a run explicitly if necessary.
Scheduled execution is best-effort and can be delayed by GitHub.

## Scheduled execution is report-only

- Health uploads its audit, summary, and assignment plan. It cannot publish
  issues or assign owners on `schedule` events.
- The auto-merge audit explicitly passes `--dry-run` and sets
  `AUTOMERGE_ENABLED=false`. There is no live-merge input or configuration-variable
  path in the workflow. `DEPENDENCY_AUTOMERGE_ENABLED` is **not** a supported
  activation switch.
- CI-gate discovery always passes `--dry-run` on `schedule` events. It cannot
  create or update rulesets. Its matrix and report depend on an enabled prepare
  job; they do not run when that job is skipped.

Manual dispatch remains available with the switches off. Existing manual
controls are unchanged: health and CI-gate default to `dry_run: true`, and
report publication defaults to off. Only an explicit manual boolean
`dry_run: false` allows their existing mutation paths. The switches govern
scheduled execution, not every administrative operation.

## Organization and repository overrides

For the same variable name, a repository configuration variable overrides its
organization value, in **both directions**:

| Organization value | Repository value | Effective value                              |
| ------------------ | ---------------- | -------------------------------------------- |
| `true`             | absent           | `true`                                       |
| `true`             | `false`          | `false`                                      |
| `false`            | `true`           | `true`                                       |
| absent             | absent           | empty string (disabled by the job condition) |

Create or remove such overrides under **Repository settings > Secrets and
variables > Actions > Variables**. All required switches must still be enabled;
overriding just the capability switch cannot bypass a disabled schedules switch.
However, repository administrators can override both: organization variables are
operational defaults, **not an unoverrideable security boundary**. Do not store
same-name overrides in `infra` if organization-level changes should be the sole
operational control. Clear old overrides before enabling or disabling a feature.

These workflows execute in **infra**, so only overrides in **infra** affect
them. A `DEPENDENCY_HEALTH_ENABLED=false` variable in `cut-extension` does not
remove that repository from the central audit. The target lists still come
from `distribution.yml` and the existing CLI selection rules. Per-target
opt-out/opt-in is not implemented by these switches and requires a separately
reviewed selection mechanism.

Reusable workflows also use the caller's repository variables, not the
variables belonging to the repository hosting the reusable workflow. These
central switches do not change the per-PR testpack callers or disable required
dependency verification.

## Safe activation and rollback

1. Merge this controls change without publishing infra or dispatching
   distribution. Inspect the configured organization and `infra` repository
   variables; a pre-existing `true` value is an activation, not a safe default.
2. Keep all switches absent or `false` during stabilization. Test the condition
   and safety contracts locally; do not enable schedules just to test the PR.
3. After the separate activation approval, enable one capability switch and
   then `DEPENDENCY_SCHEDULES_ENABLED`. The other audits remain disabled.
4. Inspect its artifacts, exact targets, and dry-run mode. A red SLA/eligibility
   report is actionable audit data, not permission to merge or rewrite rulesets.
5. To stop future scheduled audits, set the schedules switch to `false` and
   ensure no repository override masks it. Cancel active runs separately.

The heavy nightly candidate train remains a separate implementation and
end-to-end validation gate: select compatible dependency candidates, pack exact
revisions into a CLI candidate, verify installed versions, and trigger/track
the downstream check. This PR does not introduce a placeholder
`DEPENDENCY_NIGHTLY_ENABLED` switch that claims to run that missing pipeline.
Future live merge, reporting mutations, and distribution need independent
review and controls; none is enabled by these audit variables.

See [the stabilization runbook](dependency-automation-stabilization.md) for
the remaining activation gates and accepted App-token permission risk.

References:

- [Configuration variable precedence](https://docs.github.com/en/actions/reference/workflows-and-actions/variables#configuration-variable-precedence)
- [Variables context](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#vars-context)
- [Scheduled workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
