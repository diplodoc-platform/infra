# SVGO dependency exception

DEP-0001 in `dependency-policy.yml` records the SVG parser constraint for Transform. Transform pins SVGO 4.1.0, applies the Node parser patch from [svg/svgo#2224](https://github.com/svg/svgo/pull/2224), and publishes the patched dependency through npm `bundleDependencies`. CLI does not need a separate direct SVGO development dependency.

## Why an ordinary upgrade is insufficient

[DOCSTOOLS-6096](https://st.yandex-team.ru/DOCSTOOLS-6096) reports a failure while building the YDB article `ru/contributor/manage-releases.md`. Its draw.io SVG `major_release_branches.svg` exceeds SAX's default count of 512 expanded entities. This is a parsing failure before SVGO's optimization plugins run; it is not evidence of path collapsing or changed geometry.

The initial workaround pinned SVGO to 3.3.2, which uses the old `@trysound/sax` fork. Plain 4.1.0 still fails on the same SVG. The maintained patch exposes `maxEntityCount`, and Transform passes a finite higher limit for inlining. The patch must cover both the ESM source and the generated CommonJS entry used by Transform, with matching declarations. Bundling ensures published consumers receive the patched installation without a patching install script.

The historical ignored versions 3.3.3 and 3.3.4 remain in the registry. They do not prove other versions safe, and a version bump alone does not verify patch delivery.

## Reviewing a proposed update

1. Read DEP-0001 and inspect the version-specific patch in Transform's `patches/` directory.
2. Check that the patch applies to the actual ESM and CommonJS entry points, including per-call configuration isolation.
3. Run Transform's counted-entity tests and `npm run test:package`. The latter extracts the packed tarball and runs its bundled Node entries without the development installation.
4. Run CLI's SVG entity regression in both HTML and Markdown modes and build the affected YDB documentation. Distinguish existing markup errors from a missing `manage-releases` page.
5. Compare rendered SVG output when changing SVGO's plugins or parser behavior.

Use numeric or custom entities that SAX actually counts. A diagram with hundreds of predefined entities such as `&amp;` can pass even when the original incident still fails. Ordinary green tests or a source-only patch are insufficient evidence for package delivery.

For a Dependabot PR lacking this evidence, use the `dependency-exception` label and record DEP-0001 in the PR discussion. Do not silently merge or close it. Label/comment actions are separate from read-only review and require the user's authorization.

## Removing the exception

Remove the local patch and bundled dependency only after upstream releases configurable entity limits for both Node entry points and the packed npm artifact passes without the workaround. Preserve the Transform and CLI counted-entity regressions. Recheck the TypeScript import adaptation against upstream's CommonJS declarations.

Update DEP-0001 together with changes to the maintained patch or dependency pin, retaining the incident and upstream references. Keep its expiry and owner explicit; do not widen the ignored-version list to unverified ranges.
