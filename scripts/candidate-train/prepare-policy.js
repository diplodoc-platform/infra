'use strict';

const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {PACKAGE} = require('./cohort');
const {OWNER} = require('./common');
const {satisfiesStable} = require('./peer-range');

const BOT = 'diplodoc-bot';
const BRANCH_PREFIX = 'codex/dependency-group-';
const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

function preparedBranch({name, version}) {
    assert.match(name, PACKAGE);
    assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
    const id = createHash('sha256').update(`${name}@${version}`).digest('hex').slice(0, 24);
    return BRANCH_PREFIX + id;
}

function isPreparedSource(pr) {
    return (
        pr.user?.login === BOT &&
        pr.head?.repo?.full_name === `${OWNER}/${pr.base?.repo?.name}` &&
        /^codex\/dependency-group-[a-f0-9]{24}$/.test(pr.head?.ref || '')
    );
}

function lockedVersion(lock, name) {
    return lock.packages?.[`node_modules/${name}`]?.version;
}

function preparationSection(manifest, lock, {name, version}) {
    const sections = SECTIONS.filter((section) => Object.hasOwn(manifest[section] || {}, name));
    const installed = sections.filter((section) => section !== 'peerDependencies');
    assert.equal(installed.length, 1, 'Expected one installed direct dependency declaration');
    assert.ok(
        sections.every((section) => satisfiesStable(version, manifest[section][name])),
        'Declared ranges do not allow the target version',
    );
    const current = lockedVersion(lock, name);
    assert.ok(current, 'No installed direct version to update');
    assert.ok(
        satisfiesStable(current, `<${version}`),
        'Target must be an upgrade from the installed version',
    );
    return installed[0];
}

function validatePreparedLock(manifest, before, after, target) {
    preparationSection(manifest, before, target);
    assert.equal(before.lockfileVersion, 3);
    const key = `node_modules/${target.name}`;
    const {packages: current, ...lock} = before;
    const {packages: next, ...updatedLock} = after;
    assert.deepEqual(updatedLock, lock, 'Lockfile metadata changed');
    const {[key]: _oldEntry, ...unchanged} = current;
    const {[key]: entry, ...remaining} = next;
    assert.deepEqual(remaining, unchanged, 'Unrelated lockfile entries changed');
    assert.equal(entry?.version, target.version);
    const basename = target.name.split('/').at(-1);
    assert.equal(
        entry.resolved,
        `https://registry.npmjs.org/${target.name}/-/${basename}-${target.version}.tgz`,
        'Unexpected npm package archive',
    );
    assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
}

function touchesInput(before, after, oldLock, newLock, name) {
    return (
        lockedVersion(oldLock, name) !== lockedVersion(newLock, name) ||
        SECTIONS.some((section) => before[section]?.[name] !== after[section]?.[name])
    );
}

module.exports = {
    BOT,
    preparedBranch,
    isPreparedSource,
    lockedVersion,
    preparationSection,
    validatePreparedLock,
    touchesInput,
};
