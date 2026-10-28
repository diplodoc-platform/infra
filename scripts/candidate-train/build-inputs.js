'use strict';

const assert = require('node:assert/strict');
const {MODELED_RUNTIME_INPUTS} = require('./model');

/**
 * Project explicitly modeled runtime imports from their canonical development
 * declarations. This separate view never changes schema 1 source-lock evidence.
 *
 * @param {object} node Frozen registered source package.
 * @param {object} canonicalLock The package's unchanged canonical v3 lock.
 * @returns {object|null} A fresh dependency view, or null for unmodeled packages.
 */
function modeledRuntimeLock(node, canonicalLock) {
    const profile = MODELED_RUNTIME_INPUTS.find(
        (entry) => entry.repo === node.repo && entry.name === node.manifest.name,
    );

    if (!profile) return null;

    assert.equal(canonicalLock?.lockfileVersion, 3, 'Modeled runtime inputs require a v3 lock');
    const root = canonicalLock.packages?.[''];
    assert.ok(root, 'Modeled runtime inputs require a canonical lock root');
    const dependencies = {};

    for (const name of profile.dependencies) {
        if (
            Object.hasOwn(node.manifest.dependencies || {}, name) ||
            Object.hasOwn(node.manifest.optionalDependencies || {}, name) ||
            Object.hasOwn(node.manifest.peerDependencies || {}, name)
        ) {
            continue;
        }
        const spec = node.manifest.devDependencies?.[name];
        assert.ok(
            typeof spec === 'string' && spec.length > 0,
            `Missing modeled runtime dev dependency ${name}`,
        );
        assert.equal(
            root.devDependencies?.[name],
            spec,
            `Canonical lock is missing the modeled runtime declaration for ${name}`,
        );
        const entry = canonicalLock.packages[`node_modules/${name}`];
        assert.ok(
            entry && !entry.link && typeof entry.version === 'string',
            `Missing canonical modeled runtime resolution for ${name}`,
        );
        dependencies[name] = spec;
    }

    if (!Object.keys(dependencies).length) return null;

    const view = structuredClone(canonicalLock);
    view.packages[''] = {...view.packages[''], dependencies};
    delete view.packages[''].devDependencies;
    delete view.packages[''].peerDependencies;
    delete view.packages[''].peerDependenciesMeta;
    delete view.packages[''].optionalDependencies;

    return view;
}

module.exports = {modeledRuntimeLock};
