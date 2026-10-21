# Morning dependency candidate train

The train prepares an immutable temporary CLI PR from selected Dependabot
updates, privately sends the manual document-check link, and observes the
result. It never merges a source/CLI PR, publishes an npm package, distributes
infrastructure, updates snapshots, or presses the manual CI button.

## Current activation boundary

**Disabled by default. Do not enable before the downstream builder contract is
deployed and a bounded manual pilot has passed.** The existing workspace-based
builder ignores the CLI's own overrides. A standalone clean install is not
evidence that the packaged downstream binary uses the same dependency versions.

The observer therefore requires a separate trusted installed-version proof
artifact from that builder. Without this artifact, even green document checks
cannot produce a successful train result. The required proof contract is below;
adding an environment variable does not implement it in the builder.

## Sequence and time

1. At **06:17 Europe/Moscow** (`17 3 * * *`, UTC), select up to three source
   repositories from an explicit allowlist. Target readiness is **08:00 Moscow**,
   not a fixed merge time. GitHub schedules can be delayed and are not an SLA.
2. Accept only open same-repository Dependabot PRs against current `master`,
   with dependency-only manifest/lock changes and passing required exact-head
   checks. Lock-only changes are included. Major, added/removed, ignored and
   critical updates need separate individual pilots. Unknown/incomplete evidence
   fails closed. The first eligible PR per repository is selected.
3. Freeze tooling, metapackage, CLI base and source SHAs. Resolve the actual
   runtime build graph and rebuild affected consumers, including client assets
   for components changes. An unrelated package or an affected graph cycle is
   rejected rather than claimed as covered. Direct CLI-source updates are not
   supported by this first train path.
4. Build/pack candidates without secrets. Local archives and scoped exact
   dependency overrides carry the selected source lock resolutions; library
   tarball locks alone are insufficient. Reinstall the final relocatable CLI
   with `npm ci`, verify installed source identities/runtime versions, build,
   run CLI units/typecheck and HTML/Markdown smoke builds. No baseline update.
5. On a fresh runner, validate data-only artifacts against the trusted selection
   and source locks. Use a CLI-scoped App token to create immutable Git blobs and
   one `codex/dependency-candidate-<id>` branch. Use the contributor
   `diplodoc-bot` user token to open the PR, so the existing webhook can prepare
   its Internal check. No candidate code runs in the publisher.
6. Bind the owning App's Internal check and downstream flow to the CLI PR/SHA.
   Require the builder's installed-version proof, then freeze the generated
   review/diff/revision/document-check badge identity. Privately send the start
   link in Messenger. If still waiting at 08:00, send one reminder.
7. The operator starts CI manually. Observe for up to five hours, polling once
   per minute. One hour is an expectation, not an automatic success timeout.
   Require actual successful document checks, the successful owning GitHub
   check, required CLI CI, unchanged source identities and still-green source
   CI. A replaced check/diff, stale SHA, missing proof, failure or timeout is not
   success. Late readiness is reported as late.

An already open candidate blocks another train rather than accumulating heavy
parallel runs. After inspecting its result, close the temporary CLI PR **without
merge**. Keep it open on a timeout if it is still needed, and explicitly rerun
the observer job after resolving the blocking condition. A new candidate uses a
new immutable selection; branches are never force-updated.

## Organization variables

Create Actions configuration variables with access to `infra`:

| Variable                             | Default / purpose                                                                                                                |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `DEPENDENCY_CANDIDATE_TRAIN_ENABLED` | Missing/`false`: scheduled train is disabled. Use lowercase `true` only after activation approval.                               |
| `DEPENDENCY_TRAIN_REPOSITORIES`      | No default. Comma-separated explicit allowlist of 1–3 registered repositories; start with one pilot.                             |
| `DEPENDENCY_TRAIN_NOTIFY_LOGIN`      | No default. Exact private Messenger recipient login.                                                                             |
| `DEPENDENCY_TRAIN_MESSENGER_API`     | Internal bot platform by default; the common bot endpoint is also supported.                                                     |
| `DEPENDENCY_TRAIN_INTERNAL`          | No default. Private adapter JSON described below.                                                                                |
| `DEPENDENCY_TRAIN_OBSERVER_RUNNER`   | `ubuntu-latest`; use an approved private-network runner if required for the read-only adapter. Never run candidate builds there. |

The private adapter JSON contains `apiUrl`, `uiOrigin`, `reviewApiUrl`,
`reviewUiOrigin`, `artifactOrigin`, `configPath`, `actions` and
`preflightReview`. Fill these with the deployed CI/review API/UI/resource
locations, allowed action ids, and one known existing review for read-only
connectivity checks. All locations require HTTPS, with normal certificate
validation. API requests never forward credentials on redirects or to resource
hosts. Only read operations are implemented; the operator retains the button.

These locations and generated internal links must not be copied into public
issues, PR descriptions, logs or artifacts. The public result contains only
GitHub candidate identity, high-level state and readiness timing. Detailed
internal diagnostics go only to the private bot recipient.

## Credentials and preflight

Configure secrets with access to `infra`, without exposing them to build jobs:

- `INFRA_APP_ID` / `INFRA_APP_PRIVATE_KEY`: existing App credentials; publisher
  requests a token scoped only to CLI.
- `INFRA_APPROVER_PAT`: existing `diplodoc-bot` user credential, with permission
  to open the temporary CLI PR. The publisher verifies `/user` identity. The
  bot must remain in contributors; contributor approval and the later manual
  document-check button are separate gates.
- `DEPENDENCY_TRAIN_CI_TOKEN`: robot OAuth for read-only CI public API methods.
- `DEPENDENCY_TRAIN_REVIEW_TOKEN`: robot OAuth for reading the generated review,
  active diff and checks. No manual-start permission is requested.
- `DEPENDENCY_TRAIN_MESSENGER_TOKEN`: **bot** OAuth credential, not a person's
  Messenger token. The bot must be able to DM the configured recipient. Both
  HTTP status and API `ok` are checked; notification failure is not ignored.
- `DEPENDENCY_TRAIN_CA_PEM`: optional trusted CA bundle for private APIs. Never
  disable TLS validation. A configured runner also needs network access.

Before executing package code or publishing a candidate, a separate trusted
preflight reads action settings, a known review and bot identity. It does not
launch CI or send a message. A missing credential or inaccessible service blocks
publication; it does not create a PR that cannot be observed.

## Downstream installed-proof protocol

The builder must apply the approved CLI candidate's archive substitutions and
scoped exact overrides to its actual installation root before building. Paths
must be adapted to the workspace install, not blindly prepended. Preserve
unrelated builder settings. After its final root install, verify the selected
source markers, archive hashes and expected locked runtime resolutions from
the frozen candidate payload. A mismatch aborts before document validation.

Only after verification, expose a trusted job badge at the configured artifact
origin whose path ends in `/dependency-train-proof.json`. It must contain:

```json
{
  "schema": 1,
  "trainId": "the frozen plan id",
  "cliSha": "the approved full CLI SHA",
  "payloadSha256": "SHA256 of the candidate dependency-train/proof.json bytes",
  "verified": true
}
```

The proof must come from the real installed tree used to package the binary,
not merely repeat flow variables or declarations. Bind it to the relevant
`release`/`publish-pr` job and exact CLI SHA. The observer rejects missing,
redirected, stale or mismatched proofs. The prerequisite builder change is
separate from this infra implementation; it must be reviewed, deployed and
tested before activation.

## Manual validation and rollback

1. Keep the enable flag absent/false. Inspect the PR and unit/integration tests.
   No release or consumer distribution is needed for these central workflows.
2. Set a one-repository allowlist, but leave the enable flag off. Dispatch with
   `dry_run: true` to inspect selection/exclusion metadata only. This does not
   build packages, open CLI PRs or send notifications.
3. Complete the builder proof prerequisite and configure private credentials,
   endpoints, runner network and the Messenger recipient.
4. After separate approval, set the enable flag to `true` and dispatch once
   with `dry_run: false`. This also permits the next scheduled run: use the
   manual pilot window deliberately, then disable the flag afterwards.
5. Inspect the real CLI payload, private manual-start message, installed proof
   and exact downstream result. Do not infer production readiness from mocks or
   an isolated standalone install.
6. For rollback set the enable flag to `false`, remove masking repository
   overrides, and cancel active runs explicitly if necessary. Turning a flag
   off does not retroactively cancel a running job or existing Internal check.

Repository variables override organization values in both directions. Since
this workflow runs in **infra**, only overrides in **infra** affect it. A
variable in a source repository does not opt that package out of a central
train; the explicit central allowlist controls selection. These are operational
defaults, not an immutable organization-wide security boundary.

Health auditing and auto-merge eligibility auditing remain separate manual-only
workflows. They neither start this train nor approve its outcome. Live auto-merge
is not part of this workflow, even after a successful train.
