'use strict';

const assert = require('node:assert/strict');
const NAME = /^(?:@[a-z0-9][a-z0-9-]*\/)?[a-z0-9][a-z0-9._-]*$/;
function lookup(lock, key, name) {
    for (;;) {
        const target = `${key ? key + '/' : ''}node_modules/${name}`;
        if (lock.packages[target]) return target;
        if (!key) return null;
        const parent = key.lastIndexOf('/node_modules/');
        key = parent < 0 ? '' : key.slice(0, parent);
    }
}
function purePeer(entry, name) {
    return (
        Object.hasOwn(entry.peerDependencies || {}, name) &&
        !Object.hasOwn(entry.dependencies || {}, name) &&
        !Object.hasOwn(entry.optionalDependencies || {}, name)
    );
}
/** Providers already owned by an ordinary source dependency retain canonical source identity. */
function sourceOwnedContexts(lock, replacements = new Set()) {
    const owned = new Set();
    let count = 0;
    const visit = (key, depth = 0) => {
        if (owned.has(key)) return;
        assert.ok(depth <= 100, 'Source ownership exceeds the depth limit');
        owned.add(key);
        const entry = lock.packages[key];
        for (const name of Object.keys({...entry.dependencies, ...entry.optionalDependencies})) {
            assert.match(name, NAME);
            assert.ok(++count <= 20000, 'Source ownership exceeds the edge limit');
            if (replacements.has(name)) continue;
            const target = lookup(lock, key, name);
            if (!target && Object.hasOwn(entry.optionalDependencies || {}, name)) continue;
            assert.ok(target, `Missing canonical source dependency ${name}`);
            visit(target, depth + 1);
        }
    };
    visit('');
    return owned;
}
module.exports = {sourceOwnedContexts, purePeer, lookup};
