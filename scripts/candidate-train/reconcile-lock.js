'use strict';

const assert = require('node:assert/strict');
const {isDeepStrictEqual} = require('node:util');
const {PACKAGE} = require('./cohort');
const {lookup, sourceOwnedContexts} = require('./peer-policy');
const {satisfiesStable} = require('./peer-range');

const MAX_EXTRA_DEPENDENCIES = 5;
const RUNTIME = ['dependencies', 'optionalDependencies', 'peerDependencies'];
const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const BRANCH = /^codex\/dependency-group-reconcile-([1-9]\d*)-([a-f0-9]{40})$/;

function reconciliationBranch(number, sha) {
    const branch = `codex/dependency-group-reconcile-${number}-${sha}`;
    assert.match(branch, BRANCH);
    return branch;
}

function reconciliationSeed(pr) {
    const match = BRANCH.exec(pr.head?.ref || '');
    if (!match || pr.user?.login !== 'diplodoc-bot') return null;
    const number = Number(match[1]);
    if (!Number.isSafeInteger(number) || pr.number === number) return null;
    return {number, sha: match[2]};
}

function packageName(key) {
    return key.split(/(?:^|\/)node_modules\//).at(-1);
}

function registryIdentity(name, entry) {
    return (
        STABLE.test(entry?.version || '') &&
        entry.resolved ===
            `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${entry.version}.tgz` &&
        /^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity || '')
    );
}

function declaredEdges(lock, sectionsFor) {
    const result = new Map();
    for (const [parent, entry] of Object.entries(lock.packages)) {
        for (const section of sectionsFor(parent)) {
            for (const [name, range] of Object.entries(entry[section] || {})) {
                if (!PACKAGE.test(name)) continue;
                const target = lookup(lock, parent, name);
                if (!target) continue;
                if (!result.has(target)) result.set(target, []);
                result.get(target).push({parent, name, range});
            }
        }
    }
    return result;
}

function hostProvider(cli, name, version, parent = '') {
    if (!STABLE.test(version || '')) return;
    const target = lookup(cli, parent, name);
    const provider = cli.packages[target];
    if (provider?.version === version && registryIdentity(name, provider)) return provider;
}

function scopedHostPins(manifest, cli) {
    const pins = new Map();
    for (const [parentName, override] of Object.entries(manifest.overrides || {})) {
        if (!PACKAGE.test(parentName) || !override || typeof override !== 'object') continue;
        const parent = lookup(cli, '', parentName);
        if (!parent || override['.'] !== cli.packages[parent].version) continue;

        for (const [name, version] of Object.entries(override)) {
            if (!PACKAGE.test(name)) continue;
            const provider = hostProvider(cli, name, version, parent);
            if (provider) pins.set(`${parentName}@${override['.']}>${name}`, provider);
        }
    }
    return pins;
}

function alignmentTargets(before, source, cli, manifest, primary) {
    const owned = sourceOwnedContexts(source);
    const overrides = scopedHostPins(manifest, cli);
    const targets = new Map();
    const suggest = (key, name, provider) => {
        if (!key || !provider || provider.version === source.packages[key].version) return;
        if (name === primary || name.startsWith('@diplodoc/') || !owned.has(key)) return;

        assert.deepEqual(
            source.packages[key],
            before.packages[key],
            `${key}: already changed by the original PR`,
        );
        const previous = targets.get(key);
        assert.ok(
            !previous || isDeepStrictEqual(provider, previous),
            `${key}: incompatible CLI pins`,
        );
        targets.set(key, provider);
    };

    for (const name of Object.keys(source.packages[''].dependencies || {})) {
        const provider = hostProvider(cli, name, manifest.dependencies?.[name]);
        suggest(lookup(source, '', name), name, provider);
    }

    for (const parent of owned) {
        if (!parent) continue;
        const entry = source.packages[parent];
        for (const name of Object.keys({...entry.dependencies, ...entry.optionalDependencies})) {
            const selector = `${packageName(parent)}@${entry.version}>${name}`;
            suggest(lookup(source, parent, name), name, overrides.get(selector));
        }
    }
    return targets;
}

/** Pin only a proven CLI provider, keeping the source graph and every other lock entry intact. */
function reconcileLock(before, source, cli, cliManifest, primary) {
    assert.equal(before.lockfileVersion, 3);
    assert.equal(source.lockfileVersion, 3);
    assert.equal(cli.lockfileVersion, 3);
    const targets = alignmentTargets(before, source, cli, cliManifest, primary);
    const changes = [];
    const lock = structuredClone(source);
    const incoming = declaredEdges(source, (parent) =>
        parent ? RUNTIME : [...RUNTIME, 'devDependencies'],
    );

    for (const [key, provider] of targets) {
        const name = packageName(key);
        const old = source.packages[key];
        assert.ok(registryIdentity(name, old), `${key}: unsupported source package identity`);
        assert.ok(
            satisfiesStable(old.version, `<${provider.version}`) &&
                old.version.split('.')[0] === provider.version.split('.')[0],
            `${key}: require a non-major upgrade`,
        );
        const edges = incoming.get(key);
        assert.ok(edges?.length, `${key}: no canonical incoming edges`);
        for (const {parent, range} of edges) {
            assert.ok(
                satisfiesStable(provider.version, range),
                `${parent || 'package.json'} > ${name}: ${range} excludes ${provider.version}`,
            );
        }

        // Registry metadata is frozen by the CLI lock. Expanding or changing a
        // package's own dependency declarations requires a separately reviewed update.
        const metadata = ({
            version,
            resolved,
            integrity,
            dev,
            devOptional,
            optional,
            peer,
            ...rest
        }) => rest;
        assert.deepEqual(
            metadata(old),
            metadata(provider),
            `${key}: provider changes package metadata`,
        );
        const {version, resolved, integrity} = provider;
        lock.packages[key] = {...old, version, resolved, integrity};
        changes.push({key, name, from: old.version, to: version, edges});
    }
    assert.ok(
        new Set(changes.map(({name}) => name)).size <= MAX_EXTRA_DEPENDENCIES,
        'More than five additional dependencies',
    );
    return {lock, changes};
}

module.exports = {
    MAX_EXTRA_DEPENDENCIES,
    reconciliationSeed,
    reconciliationBranch,
    reconcileLock,
    packageName,
};
