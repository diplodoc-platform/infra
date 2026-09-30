'use strict';

const {isDeepStrictEqual} = require('node:util');

const SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Derive auto-merge evidence from complete immutable manifests, never diff snippets. */
function deriveManifestEvidence(beforePackage, afterPackage, beforeLock, afterLock) {
    const unknown = {
        section: null,
        updateType: 'unknown',
        dependency: null,
        newTransitiveDependencies: null,
    };
    if (
        ![beforePackage, afterPackage, beforeLock, afterLock].every(isRecord) ||
        ![beforeLock, afterLock].every(
            (lock) =>
                [2, 3].includes(lock.lockfileVersion) &&
                isRecord(lock.packages) &&
                isRecord(lock.packages['']),
        )
    )
        return unknown;
    const withoutDependencies = (manifest) =>
        Object.fromEntries(Object.entries(manifest).filter(([key]) => !SECTIONS.includes(key)));
    if (!isDeepStrictEqual(withoutDependencies(beforePackage), withoutDependencies(afterPackage)))
        return unknown;
    const changes = [];
    for (const section of SECTIONS) {
        const before = beforePackage[section] || {};
        const after = afterPackage[section] || {};
        if (!isRecord(before) || !isRecord(after)) return unknown;
        if (
            !isDeepStrictEqual(before, beforeLock.packages[''][section] || {}) ||
            !isDeepStrictEqual(after, afterLock.packages[''][section] || {})
        )
            return unknown;
        for (const dependency of new Set([...Object.keys(before), ...Object.keys(after)])) {
            if (before[dependency] !== after[dependency])
                changes.push({
                    section,
                    dependency,
                    before: before[dependency],
                    after: after[dependency],
                });
        }
    }
    if (changes.length !== 1) return unknown;
    const change = changes[0];
    const from =
        typeof change.before === 'string' && change.before.match(/^([~^]?)(\d+)\.(\d+)\.(\d+)$/);
    const to =
        typeof change.after === 'string' && change.after.match(/^([~^]?)(\d+)\.(\d+)\.(\d+)$/);
    const patch =
        from &&
        to &&
        from[1] === to[1] &&
        from[2] === to[2] &&
        from[3] === to[3] &&
        Number(to[4]) > Number(from[4]);
    const added = Object.keys(afterLock.packages).filter(
        (key) => key !== '' && !Object.hasOwn(beforeLock.packages, key),
    );
    return {
        section: change.section,
        dependency: change.dependency,
        updateType: patch ? 'patch' : 'unknown',
        newTransitiveDependencies: added.length,
    };
}

module.exports = {deriveManifestEvidence};
