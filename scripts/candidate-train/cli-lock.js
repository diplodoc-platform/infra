'use strict';

const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {assertSameLockedTree} = require('./dependency-delta');

const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const RUNTIME = ['dependencies', 'optionalDependencies', 'peerDependencies'];
const MAX_PACKAGES = 20000;
const NAME = /^(?:@[a-z0-9][a-z0-9-]*\/)?[a-z0-9][a-z0-9._-]*$/;

function lookup(lock, context, name) {
    for (;;) {
        const key = `${context ? context + '/' : ''}node_modules/${name}`;
        if (lock.packages[key]) return key;
        if (!context) return null;
        const parent = context.lastIndexOf('/node_modules/');
        context = parent < 0 ? '' : context.slice(0, parent);
    }
}

function dependencies(entry, sections = RUNTIME) {
    return [...new Set(sections.flatMap((section) => Object.keys(entry[section] || {})))];
}

function optional(entry, name) {
    return (
        Object.hasOwn(entry.optionalDependencies || {}, name) ||
        entry.peerDependenciesMeta?.[name]?.optional === true
    );
}

/** Keep host peer providers immutable; do not hide an incompatible source peer by hoisting. */
function checkPeers(baseline, archive, context, replacements) {
    const source = archive.lock;
    const root = source.packages[''];
    const inherited = new Set();
    for (const name of Object.keys(root.peerDependencies || {})) {
        if (
            Object.hasOwn(root.dependencies || {}, name) ||
            Object.hasOwn(root.optionalDependencies || {}, name)
        ) {
            continue;
        }
        inherited.add(name);
        if (replacements.has(name)) continue;
        const expected = lookup(source, '', name);
        if (!expected && optional(root, name)) continue;
        assert.ok(expected, `Missing canonical peer ${name} in ${archive.repo}`);
        const actual = lookup(baseline, context, name);
        assert.ok(actual, `Missing frozen CLI peer ${name} for ${archive.repo}`);
        try {
            assertSameLockedTree(source, expected, baseline, actual);
        } catch (error) {
            throw new Error(
                `Cannot preserve frozen CLI peer ${name} for ${archive.repo}: ` +
                    `source ${source.packages[expected].version}, CLI ${baseline.packages[actual].version}. ` +
                    'Refresh the CLI baseline explicitly; do not replace its provider during a train. ' +
                    error.message,
                {cause: error},
            );
        }
    }
    return inherited;
}

/**
 * Substitute archives in a scratch v3 lock without asking npm to re-resolve
 * unrelated packages. Canonical source locks and the CLI baseline stay unchanged.
 */
function assembleCliLock(baseline, manifest, archives, archiveBytes) {
    assert.equal(baseline.lockfileVersion, 3);
    assert.ok(Object.keys(baseline.packages || {}).length <= MAX_PACKAGES);
    for (const key of Object.keys(baseline.packages || {})) {
        if (!key) continue;
        assert.ok(key.startsWith('node_modules/'), 'Invalid baseline package location');
        key.slice('node_modules/'.length)
            .split('/node_modules/')
            .forEach((name) => assert.match(name, NAME));
    }
    const lock = structuredClone(baseline);
    const packages = lock.packages;
    assert.ok(packages?.['']);
    for (const section of SECTIONS) {
        if (manifest[section]) packages[''][section] = structuredClone(manifest[section]);
        else delete packages[''][section];
    }

    const contexts = [];
    for (const [name, archive] of archives) {
        assert.equal(archive.lock.lockfileVersion, 3);
        assert.equal(archive.lock.packages[''].version, archive.manifest.version);
        for (const key of Object.keys(baseline.packages)) {
            if (key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`))
                contexts.push({key, name, archive});
        }
        if (
            SECTIONS.some((section) => Object.hasOwn(manifest[section] || {}, name)) &&
            !contexts.some((item) => item.key === `node_modules/${name}`)
        ) {
            contexts.push({key: `node_modules/${name}`, name, archive});
        }
    }
    const top = contexts.filter(
        (item) => !contexts.some((parent) => item.key.startsWith(parent.key + '/node_modules/')),
    );
    const inherited = new Map(
        top.map(({key, archive}) => [key, checkPeers(baseline, archive, key, archives)]),
    );
    for (const {key} of top) {
        for (const current of Object.keys(packages)) {
            if (current === key || current.startsWith(key + '/node_modules/'))
                delete packages[current];
        }
    }
    const roots = new Set(
        top.filter(({key, name}) => key === `node_modules/${name}`).map((n) => n.name),
    );
    for (const {key, name, archive} of top) {
        const source = archive.lock;
        const seen = new Set();
        const visit = (sourceKey, depth = 0) => {
            if (seen.has(sourceKey)) return;
            assert.ok(depth <= 100, 'Canonical archive dependency depth exceeds the limit');
            seen.add(sourceKey);
            const target = sourceKey ? `${key}/${sourceKey}` : key;
            const entry = source.packages[sourceKey];
            assert.ok(entry && !entry.link, 'Only canonical package entries may be assembled');
            packages[target] = structuredClone(entry);
            delete packages[target].dev;
            delete packages[target].devOptional;
            if (baseline.packages[key]?.dev) packages[target].dev = true;
            if (!sourceKey) {
                delete packages[target].name;
                delete packages[target].devDependencies;
                const spec = SECTIONS.map((section) => manifest[section]?.[name]).find((value) =>
                    value?.startsWith('file:'),
                );
                packages[target].resolved =
                    spec || `file:dependency-train/payload/${archive.repo}.tgz`;
                packages[target].integrity =
                    `sha512-${createHash('sha512').update(archiveBytes(archive.repo)).digest('base64')}`;
            }
            assert.ok(
                Object.keys(packages).length <= MAX_PACKAGES,
                'Assembled CLI lock exceeds the package limit',
            );
            for (const child of dependencies(entry)) {
                assert.match(child, NAME);
                if (roots.has(child) || inherited.get(key).has(child)) continue;
                assert.ok(
                    !archives.has(child),
                    `Candidate ${child} needs a reachable CLI archive context`,
                );
                const next = lookup(source, sourceKey, child);
                if (!next && optional(entry, child)) continue;
                assert.ok(next, `Missing canonical dependency ${child} in ${archive.repo}`);
                visit(next, depth + 1);
            }
        };
        visit('');
    }
    return lock;
}

/** Check the actual frozen CLI tree too; an unchanged lock alone is insufficient. */
function verifyFrozenCli(baseline, directory, archives, resolveInstalled) {
    const seen = new Set();
    let edges = 0;
    const visit = (key, context, depth = 0, inheritedOptional = false) => {
        const state = `${key}\0${context}`;
        if (seen.has(state)) return;
        seen.add(state);
        assert.ok(depth <= 100, 'Frozen CLI installation exceeds the depth limit');
        const entry = baseline.packages[key];
        const names = dependencies(entry, key ? RUNTIME : SECTIONS);
        for (const name of names) {
            assert.ok(++edges <= 20000, 'Frozen CLI installation exceeds the edge limit');
            assert.match(name, NAME);
            const actual = resolveInstalled(context, name);
            const isOptional = inheritedOptional || optional(entry, name);
            if (!actual && isOptional) continue;
            assert.ok(actual, `Missing frozen CLI dependency ${name}`);
            const replacement = archives.get(name);
            if (replacement) {
                assert.equal(actual.manifest.version, replacement.manifest.version);
                assert.equal(
                    actual.manifest.dependencyTrain?.sourceSha,
                    replacement.sha,
                    `Frozen CLI archive fallback for ${name}`,
                );
                continue;
            }
            const expected = lookup(baseline, key, name);
            assert.ok(expected, `Unexpected installed CLI provider ${name}`);
            assert.equal(
                actual.manifest.version,
                baseline.packages[expected].version,
                `Frozen installed CLI dependency changed: ${name}`,
            );
            visit(expected, actual.directory, depth + 1, isOptional);
        }
    };
    visit('', directory);
}

module.exports = {assembleCliLock, verifyFrozenCli};
