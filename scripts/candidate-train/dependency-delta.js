'use strict';

const assert = require('node:assert/strict');
const {buildOrder} = require('./common');
const {optInExtension} = require('./model');
const {modeledRuntimeLock} = require('./build-inputs');

const NAME = /^(?:@[a-z0-9][a-z0-9-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const RUNTIME = ['dependencies', 'peerDependencies', 'optionalDependencies'];
const MAX_DEPTH = 100;
const MAX_EDGES = 20000;

function validateLock(lock) {
    assert.equal(lock?.lockfileVersion, 3, 'Dependency comparison requires a v3 lock');
    assert.ok(lock.packages?.[''], 'Dependency comparison requires a lock root');
}

function lookup(lock, context, name) {
    for (;;) {
        const key = `${context ? context + '/' : ''}node_modules/${name}`;
        if (lock.packages[key]) return key;
        if (!context) return null;
        const parent = context.lastIndexOf('/node_modules/');
        context = parent < 0 ? '' : context.slice(0, parent);
    }
}

function edges(entry, includeDev) {
    const result = new Map();

    for (const section of [...RUNTIME, ...(includeDev ? ['devDependencies'] : [])]) {
        for (const [name, spec] of Object.entries(entry[section] || {})) {
            assert.match(name, NAME);
            assert.equal(typeof spec, 'string', 'Dependency spec must be a string');
            if (!result.has(name)) result.set(name, {specs: {}, optional: false});
            result.get(name).specs[section] = spec;
        }
    }

    for (const [name, edge] of result) {
        edge.optional =
            Object.hasOwn(entry.optionalDependencies || {}, name) ||
            entry.peerDependenciesMeta?.[name]?.optional === true;
    }

    return result;
}

function identity(entry) {
    assert.ok(!entry.link && typeof entry.version === 'string', 'Missing dependency version');
    assert.equal(typeof entry.resolved, 'string', 'Missing dependency resolution identity');
    assert.equal(typeof entry.integrity, 'string', 'Missing dependency integrity identity');
    return {version: entry.version, resolved: entry.resolved, integrity: entry.integrity};
}

function contexts(lock, additionalEdges = new Map()) {
    const result = new Map();
    const seen = new Set();
    let count = 0;

    function visit(key, depth, optional = false) {
        const state = `${key}\0${optional}`;
        if (seen.has(state)) return;
        seen.add(state);
        assert.ok(depth <= MAX_DEPTH, 'Dependency comparison exceeds the depth limit');

        const entry = lock.packages[key];
        const modeled = additionalEdges.get(key);
        const effective = modeled
            ? {...entry, dependencies: {...entry.dependencies, ...modeled}}
            : entry;

        for (const [name, edge] of edges(effective, key === '')) {
            assert.ok(++count <= MAX_EDGES, 'Dependency comparison exceeds the size limit');
            const target = lookup(lock, key, name);
            if (!target && (optional || edge.optional)) continue;
            assert.ok(target, `Missing locked dependency ${name}`);
            const entry = lock.packages[target];
            assert.ok(!entry.link && typeof entry.version === 'string');
            if (!result.has(name)) result.set(name, new Set());
            result.get(name).add(target);

            visit(target, depth + 1, optional || edge.optional);
        }
    }

    visit('', 0);
    return result;
}

function compare(expectedLock, expectedRoot, actualLock, actualRoot, options) {
    const seen = new Set();
    let count = 0;
    const fail = (trail, reason) => {
        throw new Error(
            `${options.label}: ${trail}: ${reason}. Refresh the CLI baseline explicitly; ` +
                'unrelated dependency changes are not part of this train',
        );
    };

    function visit(expectedKey, actualKey, trail, depth, includeDev, optional = false) {
        const state = `${expectedKey}\0${actualKey}\0${includeDev}\0${optional}`;
        if (seen.has(state)) return;
        seen.add(state);
        assert.ok(depth <= MAX_DEPTH, 'Dependency comparison exceeds the depth limit');
        const expectedEdges = edges(expectedLock.packages[expectedKey], includeDev);
        const actualEdges = edges(actualLock.packages[actualKey], includeDev);
        const names = [...new Set([...expectedEdges.keys(), ...actualEdges.keys()])].sort();

        for (const name of names) {
            assert.ok(++count <= MAX_EDGES, 'Dependency comparison exceeds the size limit');
            const location = trail ? `${trail} > ${name}` : name;
            const expected = expectedEdges.get(name);
            const actual = actualEdges.get(name);
            const archive = options.archives.get(name);

            if (!expected && actual && options.allowOptInRoots && depth === 0) {
                const profile = optInExtension(name);
                const permittedRoot =
                    archive &&
                    options.selected.has(name) &&
                    profile?.name === name &&
                    profile.repo === archive.repo &&
                    !actual.optional &&
                    Object.keys(actual.specs).length === 1 &&
                    actual.specs.dependencies ===
                        `file:dependency-train/payload/${archive.repo}.tgz`;

                // Every installed archive is compared with its canonical source
                // lock below, including these explicitly selected CLI additions.
                if (permittedRoot) continue;
            }

            if (!expected || !actual) fail(location, 'dependency edge was added or removed');
            if (expected.optional !== actual.optional)
                fail(location, 'dependency optionality changed');

            for (const section of new Set([
                ...Object.keys(expected.specs),
                ...Object.keys(actual.specs),
            ])) {
                if (Object.hasOwn(expected.specs, section) !== Object.hasOwn(actual.specs, section))
                    fail(location, `${section} edge was added or removed`);
                const permittedArchiveSpec =
                    archive &&
                    actual.specs[section] === `file:dependency-train/payload/${archive.repo}.tgz`;
                if (expected.specs[section] !== actual.specs[section] && !permittedArchiveSpec)
                    fail(location, `${section} declaration changed`);
            }

            const expectedTarget = lookup(expectedLock, expectedKey, name);
            const actualTarget = lookup(actualLock, actualKey, name);
            const optionalEdge = optional || expected.optional;
            if (!actualTarget && optionalEdge) continue;
            if (!expectedTarget && !actualTarget && optionalEdge) continue;
            if (!expectedTarget || !actualTarget)
                fail(location, 'missing canonical or candidate resolution');

            const before = expectedLock.packages[expectedTarget];
            const after = actualLock.packages[actualTarget];
            assert.ok(!after.link && typeof after.version === 'string');

            if (archive) {
                if (
                    options.validateArchives &&
                    (after.version !== archive.manifest.version ||
                        after.resolved !== `file:dependency-train/payload/${archive.repo}.tgz`)
                ) {
                    fail(location, 'archive does not match its frozen source');
                }
                // Canonical archive children are checked independently in every
                // installed context, rather than trusting their parent's lock.
                if (options.cutArchives) continue;
                if (after.version !== archive.manifest.version)
                    fail(location, 'archive version does not match its frozen source');
                if (options.selected.has(name)) continue;
                if (before.version !== after.version)
                    fail(
                        location,
                        `unselected archive version ${before.version} -> ${after.version}`,
                    );
            } else {
                const beforeIdentity = identity(before);
                const afterIdentity = identity(after);
                const changed = Object.keys(beforeIdentity).filter(
                    (field) => beforeIdentity[field] !== afterIdentity[field],
                );
                if (changed.length)
                    fail(
                        location,
                        `resolution changed [${changed.join(', ')}] (${before.version} -> ${after.version})`,
                    );
            }

            // Reused hoisted nodes need one comparison per resolution context,
            // not exponentially many identical logical paths. The closing edge
            // was checked above before a visited context is skipped.
            visit(expectedTarget, actualTarget, location, depth + 1, false, optionalEdge);
        }
    }

    visit(expectedRoot, actualRoot, '', 0, options.includeDev === true);
}

function sourceContext(plan, baselineLock, sourceLocks) {
    validateLock(baselineLock);
    assert.ok(sourceLocks instanceof Map, 'Canonical source locks are required');
    const archives = new Map(
        buildOrder(plan.graph, plan.selected)
            .filter((node) => node.repo !== 'cli')
            .map((node) => [node.manifest.name, node]),
    );
    const selected = new Set(plan.selected.map((node) => node.manifest.name));
    const baselineContexts = contexts(baselineLock);
    const settings = {archives, selected};

    for (const [name, archive] of archives) {
        const source = sourceLocks.get(archive.repo);
        validateLock(source);
        assert.equal(source.packages[''].version, archive.manifest.version);
        if (selected.has(name)) continue;
        const original = baselineContexts.get(name);
        assert.ok(original?.size, `Unselected archive ${name} is absent from the CLI baseline`);

        for (const context of original) {
            assert.equal(
                baselineLock.packages[context].version,
                archive.manifest.version,
                `Unplanned archive version change for ${name}; refresh the CLI baseline explicitly`,
            );
            compare(baselineLock, context, source, '', {
                ...settings,
                cutArchives: true,
                label: `Unselected consumer ${archive.repo}`,
            });
        }
    }

    return settings;
}

/** Check immutable consumer lock compatibility before installing CLI dependencies. */
function assertSourceBaselines(plan, baselineLock, sourceLocks) {
    sourceContext(plan, baselineLock, sourceLocks);
    return true;
}

/**
 * Reject resolution changes outside the selected packages' canonical locks.
 * Archive provenance remains schema 1; incompatible consumer locks require a
 * separately reviewed baseline refresh, never rewritten source-lock evidence.
 */
function assertDependencyDelta(plan, baselineLock, candidateLock, sourceLocks) {
    validateLock(candidateLock);
    const settings = sourceContext(plan, baselineLock, sourceLocks);
    const {archives} = settings;
    const additionalEdges = new Map();

    for (const [name, archive] of archives) {
        const modeled = modeledRuntimeLock(archive, sourceLocks.get(archive.repo));
        if (!modeled) continue;

        for (const [context, entry] of Object.entries(candidateLock.packages)) {
            const exactName =
                context === `node_modules/${name}` || context.endsWith(`/node_modules/${name}`);

            if (
                exactName &&
                entry.version === archive.manifest.version &&
                entry.resolved === `file:dependency-train/payload/${archive.repo}.tgz`
            ) {
                additionalEdges.set(context, modeled.packages[''].dependencies);
            }
        }
    }

    // Implicit runtime edges must participate in discovery too. Otherwise a
    // nested replacement archive could escape its independent canonical check.
    const candidateContexts = contexts(candidateLock, additionalEdges);

    compare(baselineLock, '', candidateLock, '', {
        ...settings,
        includeDev: true,
        allowOptInRoots: true,
        label: 'Unplanned CLI dependency delta',
    });

    for (const [name, archive] of archives) {
        const source = sourceLocks.get(archive.repo);
        const installed = candidateContexts.get(name);
        assert.ok(installed?.size, `Missing candidate archive ${name}`);

        for (const context of installed) {
            const entry = candidateLock.packages[context];
            assert.equal(
                entry.version,
                archive.manifest.version,
                `Archive version mismatch: ${name}`,
            );
            assert.equal(
                entry.resolved,
                `file:dependency-train/payload/${archive.repo}.tgz`,
                `Archive resolution mismatch: ${name}`,
            );
            compare(source, '', candidateLock, context, {
                ...settings,
                cutArchives: true,
                label: `Canonical source lock ${archive.repo}`,
                validateArchives: true,
            });

            const modeled = modeledRuntimeLock(archive, source);
            if (modeled) {
                // Some shipped code consumes a declared build input at runtime.
                // Resolve that explicit model edge from the archive's actual
                // installed context without rewriting canonical source evidence.
                const view = {
                    ...candidateLock,
                    packages: {
                        ...candidateLock.packages,
                        [context]: modeled.packages[''],
                    },
                };
                compare(modeled, '', view, context, {
                    ...settings,
                    cutArchives: true,
                    label: `Modeled runtime input ${archive.repo}`,
                    validateArchives: true,
                });
            }
        }
    }

    return true;
}

module.exports = {assertDependencyDelta, assertSourceBaselines};
