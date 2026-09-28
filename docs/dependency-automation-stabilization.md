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

1. Merge testpack before infra so the reusable `downstream-check.yml@master`
   exists when distributed callers start using it.
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
