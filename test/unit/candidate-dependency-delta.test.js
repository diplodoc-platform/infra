const assert = require('node:assert/strict');
const {
    assertDependencyDelta,
    assertSourceBaselines,
} = require('../../scripts/candidate-train/dependency-delta');

const tests = [];
const test = (name, fn) => tests.push({name, fn});
const LEAF = '@diplodoc/leaf';
const CONSUMER = '@diplodoc/consumer';
const metadata = (name, version, dependencies = {}) => ({
    version,
    dependencies,
    resolved: `https://registry.npmjs.org/${name}/-/${version}.tgz`,
    integrity: `sha512-${name}-${version}`,
});
const node = (repo, dependencies = {}) => ({
    repo,
    sha: 'a'.repeat(40),
    manifest: {name: `@diplodoc/${repo}`, version: '1.0.0', dependencies},
});
const source = (root, packages) => ({
    lockfileVersion: 3,
    packages: {'': {version: '1.0.0', dependencies: root}, ...packages},
});
const archived = (repo, dependencies) => ({
    ...metadata(`@diplodoc/${repo}`, '1.0.0', dependencies),
    resolved: `file:dependency-train/payload/${repo}.tgz`,
    integrity: `sha512-archive-${repo}`,
});

function fixture() {
    const graph = [
        node('leaf', {changed: '^1.0.0'}),
        node('consumer', {[LEAF]: '^1.0.0', parser: '^1.0.0'}),
        node('cli', {[CONSUMER]: '^1.0.0', stable: '^1.0.0'}),
    ];
    const baseline = source(graph[2].manifest.dependencies, {
        [`node_modules/${CONSUMER}`]: metadata(CONSUMER, '1.0.0', graph[1].manifest.dependencies),
        [`node_modules/${LEAF}`]: metadata(LEAF, '1.0.0', {changed: '^1.0.0'}),
        'node_modules/parser': metadata('parser', '1.0.0', {'js-yaml': '^4.0.0'}),
        'node_modules/js-yaml': metadata('js-yaml', '4.3.2'),
        'node_modules/changed': metadata('changed', '1.0.0'),
        'node_modules/stable': metadata('stable', '1.0.0'),
        'node_modules/tool': metadata('tool', '1.0.0'),
    });
    baseline.packages[''].devDependencies = {tool: '^1.0.0'};
    const candidate = structuredClone(baseline);
    candidate.packages[''].dependencies[CONSUMER] = 'file:dependency-train/payload/consumer.tgz';
    candidate.packages[`node_modules/${CONSUMER}`] = archived(
        'consumer',
        graph[1].manifest.dependencies,
    );
    candidate.packages[`node_modules/${LEAF}`] = archived('leaf', {changed: '^1.0.0'});
    candidate.packages['node_modules/changed'] = metadata('changed', '1.1.0');
    const locks = new Map([
        [
            'leaf',
            source(
                {changed: '^1.0.0'},
                {
                    'node_modules/changed': metadata('changed', '1.1.0'),
                },
            ),
        ],
        [
            'consumer',
            source(graph[1].manifest.dependencies, {
                [`node_modules/${LEAF}`]: metadata(LEAF, '1.0.0', {changed: '^1.0.0'}),
                'node_modules/changed': metadata('changed', '1.0.0'),
                'node_modules/parser': metadata('parser', '1.0.0', {'js-yaml': '^4.0.0'}),
                'node_modules/js-yaml': metadata('js-yaml', '4.3.2'),
            }),
        ],
    ]);

    return {plan: {graph, selected: [graph[0]]}, baseline, candidate, locks};
}

const check = ({plan, baseline, candidate, locks}) =>
    assertDependencyDelta(plan, baseline, candidate, locks);

test('dependency delta permits only the selected source-lock update and archive substitutions', () => {
    assert.equal(check(fixture()), true);
});

test('dependency delta is independent of physical npm hoisting', () => {
    const data = fixture();
    const leaf = data.candidate.packages['node_modules/changed'];
    delete data.candidate.packages['node_modules/changed'];
    data.candidate.packages[`node_modules/${LEAF}/node_modules/changed`] = leaf;
    assert.equal(check(data), true);
});

test('dependency delta rejects a vulnerable translation-style source-lock downgrade', () => {
    const data = fixture();
    data.candidate.packages['node_modules/js-yaml'] = metadata('js-yaml', '4.1.1');
    data.locks.get('consumer').packages['node_modules/js-yaml'] = metadata('js-yaml', '4.1.1');
    assert.throws(() => check(data), /Unselected consumer consumer.*js-yaml/);
});

test('canonical consumer drift is rejected before a candidate install is needed', () => {
    const data = fixture();
    data.locks.get('consumer').packages['node_modules/js-yaml'] = metadata('js-yaml', '4.1.1');
    assert.throws(
        () => assertSourceBaselines(data.plan, data.baseline, data.locks),
        /Unselected consumer consumer.*js-yaml/,
    );
});

test('dependency delta rejects unrelated changes in CLI development dependencies', () => {
    const data = fixture();
    data.candidate.packages['node_modules/tool'] = metadata('tool', '0.9.0');
    assert.throws(() => check(data), /Unplanned CLI dependency delta.*tool/);
});

test('dependency delta rejects changed integrity even when the version is identical', () => {
    const data = fixture();
    data.candidate.packages['node_modules/stable'].integrity = 'sha512-different-content';
    assert.throws(() => check(data), /Unplanned CLI dependency delta.*stable/);
});

test('selected packages must still match their exact canonical runtime source lock', () => {
    const data = fixture();
    data.candidate.packages['node_modules/changed'] = metadata('changed', '1.2.0');
    assert.throws(() => check(data), /Canonical source lock leaf.*changed/);
});

test('the candidate cannot fall back from an archive to its registry package', () => {
    const data = fixture();
    data.candidate.packages[`node_modules/${LEAF}`] = metadata(LEAF, '1.0.0', {
        changed: '^1.0.0',
    });
    assert.throws(() => check(data), /Archive resolution mismatch/);
});

test('dependency delta rejects missing canonical source locks and incomplete identities', () => {
    const data = fixture();
    data.locks.delete('consumer');
    assert.throws(() => check(data), /v3 lock/);
    const incomplete = fixture();
    delete incomplete.baseline.packages['node_modules/stable'].integrity;
    delete incomplete.candidate.packages['node_modules/stable'].integrity;
    assert.throws(() => check(incomplete), /Missing dependency integrity/);
});

test('dependency delta rejects added or removed unselected dependency edges', () => {
    for (const add of [false, true]) {
        const data = fixture();
        if (add) {
            data.candidate.packages[''].dependencies.extra = '^1.0.0';
            data.candidate.packages['node_modules/extra'] = metadata('extra', '1.0.0');
        } else {
            delete data.candidate.packages[''].dependencies.stable;
        }
        assert.throws(() => check(data), /dependency edge was added or removed/);
    }
});

test('archive substitution cannot add another dependency section', () => {
    const data = fixture();
    data.candidate.packages[''].devDependencies[CONSUMER] =
        'file:dependency-train/payload/consumer.tgz';
    assert.throws(() => check(data), /devDependencies edge was added or removed/);
});

test('dependency delta rejects an unselected archive package version change', () => {
    const data = fixture();
    data.candidate.packages[`node_modules/${CONSUMER}`].version = '1.1.0';
    data.plan.graph[1].manifest.version = '1.1.0';
    data.locks.get('consumer').packages[''].version = '1.1.0';
    assert.throws(() => check(data), /Unplanned archive version change/);
});

test('dependency delta checks peer resolutions and cycle-closing identities', () => {
    const data = fixture();
    for (const lock of [data.baseline, data.candidate]) {
        lock.packages['node_modules/stable'].peerDependencies = {tool: '^1.0.0'};
        lock.packages['node_modules/tool'].dependencies = {stable: '^1.0.0'};
    }
    assert.equal(check(data), true);
    data.candidate.packages['node_modules/tool'].integrity = 'sha512-mismatched-peer';
    assert.throws(() => check(data), /resolution changed/);
});

test('optional packages may be absent but present versions and declarations must match', () => {
    const data = fixture();
    for (const lock of [data.baseline, data.candidate]) {
        lock.packages[''].optionalDependencies = {native: '^1.0.0'};
        lock.packages['node_modules/native'] = metadata('native', '1.0.0');
    }
    delete data.candidate.packages['node_modules/native'];
    assert.equal(check(data), true);
    data.candidate.packages['node_modules/native'] = metadata('native', '1.1.0');
    assert.throws(() => check(data), /resolution changed/);
    delete data.candidate.packages[''].optionalDependencies;
    assert.throws(() => check(data), /dependency edge was added or removed/);
});

test('a present optional package requires a canonical resolution identity', () => {
    const data = fixture();
    for (const lock of [data.baseline, data.candidate])
        lock.packages[''].optionalDependencies = {native: '^1.0.0'};
    data.candidate.packages['node_modules/native'] = metadata('native', '1.0.0');
    assert.throws(() => check(data), /missing canonical or candidate resolution/);
});

function selectedParent() {
    const data = fixture();
    const parent = node('parent', {[CONSUMER]: '^1.0.0', [LEAF]: '^1.0.0'});
    data.plan.graph.splice(2, 0, parent);
    data.plan.graph[3].manifest.dependencies = {'@diplodoc/parent': '^1.0.0', stable: '^1.0.0'};
    data.plan.selected.push(parent);
    data.baseline.packages[''].dependencies = structuredClone(
        data.plan.graph[3].manifest.dependencies,
    );
    data.candidate.packages[''].dependencies = {
        '@diplodoc/parent': 'file:dependency-train/payload/parent.tgz',
        stable: '^1.0.0',
    };
    data.baseline.packages['node_modules/@diplodoc/parent'] = metadata(
        '@diplodoc/parent',
        '1.0.0',
        parent.manifest.dependencies,
    );
    data.candidate.packages['node_modules/@diplodoc/parent'] = archived(
        'parent',
        parent.manifest.dependencies,
    );
    data.locks.set(
        'parent',
        source(parent.manifest.dependencies, {
            [`node_modules/${CONSUMER}`]: metadata(CONSUMER, '1.0.0'),
            [`node_modules/${LEAF}`]: metadata(LEAF, '1.0.0'),
        }),
    );
    return data;
}

test('unchanged archives under a selected parent cannot bypass CLI baseline protection', () => {
    const data = selectedParent();
    data.candidate.packages['node_modules/js-yaml'] = metadata('js-yaml', '4.1.1');
    data.locks.get('consumer').packages['node_modules/js-yaml'] = metadata('js-yaml', '4.1.1');
    assert.throws(() => check(data), /Unselected consumer consumer.*js-yaml/);
});

test('every baseline context is checked rather than choosing the first compatible consumer', () => {
    const data = selectedParent();
    for (const lock of [data.baseline, data.candidate, data.locks.get('parent')]) {
        lock.packages['node_modules/holder'] = metadata('holder', '1.0.0', {[CONSUMER]: '^1.0.0'});
    }
    data.baseline.packages['node_modules/@diplodoc/parent'].dependencies.holder = '^1.0.0';
    data.candidate.packages['node_modules/@diplodoc/parent'].dependencies.holder = '^1.0.0';
    data.locks.get('parent').packages[''].dependencies.holder = '^1.0.0';
    data.baseline.packages[`node_modules/holder/node_modules/${CONSUMER}`] = metadata(
        CONSUMER,
        '1.0.0',
        {[LEAF]: '^1.0.0', parser: '^1.0.0'},
    );
    data.baseline.packages['node_modules/holder/node_modules/js-yaml'] = metadata(
        'js-yaml',
        '4.1.1',
    );
    data.baseline.packages['node_modules/holder/node_modules/parser'] = metadata(
        'parser',
        '1.0.0',
        {'js-yaml': '^4.0.0'},
    );
    assert.throws(() => check(data), /Unselected consumer consumer.*js-yaml/);
});

test('dependency comparison rejects excessive depth instead of truncating evidence', () => {
    const data = fixture();
    for (const lock of [data.baseline, data.candidate]) {
        lock.packages[''].dependencies.deep0 = '*';
        for (let index = 0; index < 102; index++) {
            lock.packages[`node_modules/deep${index}`] = metadata(
                `deep${index}`,
                '1.0.0',
                index < 101 ? {[`deep${index + 1}`]: '*'} : {},
            );
        }
    }
    assert.throws(() => check(data), /depth limit/);
});

test('dependency comparison memoizes repeated hoisted contexts without dropping identities', () => {
    const data = fixture();
    for (const lock of [data.baseline, data.candidate]) {
        lock.packages[''].dependencies.n0a = '*';
        for (let index = 0; index < 16; index++) {
            const dependencies =
                index < 15 ? {[`n${index + 1}a`]: '*', [`n${index + 1}b`]: '*'} : {};
            for (const suffix of ['a', 'b']) {
                const name = `n${index}${suffix}`;
                lock.packages[`node_modules/${name}`] = metadata(name, '1.0.0', dependencies);
            }
        }
    }
    assert.equal(check(data), true);
    data.candidate.packages['node_modules/n15b'].version = '0.9.0';
    assert.throws(() => check(data), /resolution changed/);
});

test('dependency comparison rejects excessive distinct edges instead of truncating evidence', () => {
    const data = fixture();
    for (const lock of [data.baseline, data.candidate]) {
        for (let index = 0; index < 20001; index++) {
            const name = `many${index}`;
            lock.packages[''].dependencies[name] = '*';
            lock.packages[`node_modules/${name}`] = metadata(name, '1.0.0');
        }
    }
    assert.throws(() => check(data), /size limit/);
});

module.exports = {tests};
