# SVGO parser patch maintenance

DEP-0001 in `dependency-policy.yml` records the exact development pin required by Transform's version-specific parser patch. It is not a downgrade guard. Transform pins the development dependency SVGO 4.1.0, applies the Node parser patch from [svg/svgo#2224](https://github.com/svg/svgo/pull/2224), and builds its patched Node parser into an isolated internal module. CLI does not need a separate direct SVGO development dependency.

## Why an ordinary upgrade is insufficient

[svg/svgo#2218](https://github.com/svg/svgo/issues/2218) reports failures with entity-heavy SVG metadata, reproduced while building the YDB article `ru/core/contributor/manage-releases.md`. Its draw.io SVG `major_release_branches.svg` exceeds SAX's default count of 512 expanded entities. This is a parsing failure before SVGO's optimization plugins run; it is not evidence of path collapsing or changed geometry.

The initial workaround pinned SVGO to 3.3.2, which uses the old `@trysound/sax` fork. Plain 4.1.0 still fails on the same SVG. The maintained patch exposes `maxEntityCount`, and Transform accepts an optional `svgMaxEntityCount` override for inlining. CLI forwards `content.svgMaxEntityCount` or `--svg-max-entity-count` in both HTML and Markdown builds. Neither package passes an entity limit by default; SVGO owns the default. The patch must cover both the ESM source and the generated CommonJS entry used by Transform, with matching declarations. The internal bundle includes the patched parser and dependency code without a patching install script or a runtime SVGO dependency. npm `bundleDependencies` is unsuitable here because its dependency tree can collide with an existing consumer's parser dependencies.

SVGO 3.3.3 and 3.3.4 are no longer ignored: the 4.x dependency does not resolve to those versions. DEP-0001 now only registers the exact 4.1.0 development pin required by the local patch. Removing that entry while retaining the exact pin would violate `enforce-exact-pin`; remove both when the upstream option makes the patch unnecessary.

## Reviewing a proposed update

1. Read DEP-0001 and inspect the version-specific patch in Transform's `patches/` directory.
2. Check that the patch applies to the actual ESM and CommonJS entry points, including per-call configuration isolation.
3. Run Transform's counted-entity tests and `npm run test:package`. The latter extracts the packed tarball, runs its bundled Node entries without the development installation, and compiles public types in a clean consumer without SVGO and with `skipLibCheck: false`.
4. Run CLI's SVG entity regression in both HTML and Markdown modes and build the affected YDB documentation with and without an explicit entity limit. Verify that omitted configuration keeps SVGO's default parser limit, preserves the image reference and warns, while an explicit sufficient limit permits inlining. Other parser errors must still fail. Entity-limit handling and warning generation belong to the shared `replaceSvgContent` helper; both callers preserve the original image on an empty result. Verify a single warning for repeated uses of one SVG with one caller logger. Distinguish existing markup errors from a missing `manage-releases` page.
5. Compare rendered SVG output when changing SVGO's plugins or parser behavior.

Use numeric or custom entities that SAX actually counts. A diagram with hundreds of predefined entities such as `&amp;` can pass even when the original incident still fails. Ordinary green tests or a source-only patch are insufficient evidence for package delivery.

When Dependabot proposes a newer version, update and verify the version-specific patch before accepting the update. The patch helper checks the installed version, so an unadapted upgrade fails explicitly. No historical 3.x ignore list or blanket ignore of future 4.x versions is needed. Installation tolerates an unavailable patch so hook setup can still run; the build and packaging checks fail until a proposed version's patch is adapted.

## Removing the exception

Remove the local patch only after upstream releases configurable entity limits for both Node entry points and the packed npm artifact passes without the workaround. Preserve the Transform and CLI counted-entity regressions. Recheck the TypeScript import adaptation against upstream's CommonJS declarations.

Update DEP-0001 together with changes to the maintained patch, internal bundle or dependency pin, retaining the public upstream references. Keep its expiry and owner explicit. Leave `ignored-versions` empty.
