const assert = require('node:assert/strict');
const {
    assertDependencyDelta,
    assertSourceBaselines,
} = require('../../scripts/candidate-train/dependency-delta');

const tests = [];
const test = (name, fn) => tests.push({name, fn});
const LEAF = '@diplodoc/leaf';
const CONSUMER = '@diplodoc/consumer';
const HTML = '@diplodoc/html-extension';
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

function optInFixture(repo = 'html-extension') {
    const data = fixture();
    const extension = node(repo, {'opt-parser': '^2.0.0'});
    const name = extension.manifest.name;
    data.plan.graph.splice(2, 0, extension);
    data.plan.selected.push(extension);
    data.candidate.packages[''].dependencies[name] = `file:dependency-train/payload/${repo}.tgz`;
    data.candidate.packages[`node_modules/${name}`] = archived(
        extension.repo,
        extension.manifest.dependencies,
    );
    data.candidate.packages['node_modules/opt-parser'] = metadata('opt-parser', '2.1.0');
    data.locks.set(
        extension.repo,
        source(extension.manifest.dependencies, {
            'node_modules/opt-parser': metadata('opt-parser', '2.1.0'),
        }),
    );

    if (repo === 'folding-headings-extension') {
        const utils = '@diplodoc/utils';
        extension.manifest.devDependencies = {[utils]: '^1.0.0'};
        const lock = data.locks.get(repo);
        lock.packages[''].devDependencies = {[utils]: '^1.0.0'};
        lock.packages[`node_modules/${utils}`] = metadata(utils, '1.0.0');

        for (const candidate of [data.baseline, data.candidate]) {
            candidate.packages[''].dependencies[utils] = '^1.0.0';
            candidate.packages[`node_modules/${utils}`] = metadata(utils, '1.0.0');
        }
    }

    return data;
}

test('dependency delta permits only the selected source-lock update and archive substitutions', () => {
    assert.equal(check(fixture()), true);
});

test('selected opt-in archives may add an exact CLI dependency without changing its baseline', () => {
    for (const repo of [
        'algolia-extension',
        'folding-headings-extension',
        'html-extension',
        'quote-link-extension',
    ]) {
        const data = optInFixture(repo);
        const baseline = structuredClone(data.baseline);
        const manifests = data.plan.graph.map((item) => structuredClone(item.manifest));

        assert.equal(check(data), true);
        assert.deepEqual(data.baseline, baseline);
        assert.deepEqual(
            data.plan.graph.map((item) => item.manifest),
            manifests,
        );
    }
});

test('an opt-in archive cannot authorize an unknown new CLI dependency', () => {
    const data = optInFixture();
    data.candidate.packages[''].dependencies['@diplodoc/unknown-extension'] =
        'file:dependency-train/payload/unknown-extension.tgz';
    data.candidate.packages['node_modules/@diplodoc/unknown-extension'] =
        archived('unknown-extension');

    assert.throws(() => check(data), /unknown-extension.*dependency edge was added or removed/);
});

test('a new opt-in archive is allowed only in the CLI dependencies section', () => {
    for (const section of ['devDependencies', 'optionalDependencies', 'peerDependencies']) {
        const data = optInFixture();
        delete data.candidate.packages[''].dependencies[HTML];
        data.candidate.packages[''][section] ||= {};
        data.candidate.packages[''][section][HTML] =
            'file:dependency-train/payload/html-extension.tgz';

        assert.throws(() => check(data), /html-extension.*dependency edge was added or removed/);
    }
});

test('a new opt-in archive cannot add a second CLI dependency section', () => {
    const data = optInFixture();
    data.candidate.packages[''].devDependencies[HTML] =
        'file:dependency-train/payload/html-extension.tgz';

    assert.throws(() => check(data), /html-extension.*dependency edge was added or removed/);
});

test('an unselected opt-in archive cannot be added to the CLI root', () => {
    const data = optInFixture();
    data.plan.selected = data.plan.selected.filter((item) => item.manifest.name !== HTML);

    assert.throws(() => check(data), /html-extension.*dependency edge was added or removed/);
});

test('an opt-in archive must match the trusted profile repository identity', () => {
    const data = optInFixture();
    const extension = data.plan.graph.find((item) => item.manifest.name === HTML);
    extension.repo = 'unexpected-extension';
    const cli = data.plan.graph.find((item) => item.repo === 'cli');
    cli.manifest.dependencies = {...cli.manifest.dependencies, [HTML]: '^1.0.0'};
    data.locks.set(extension.repo, data.locks.get('html-extension'));
    data.candidate.packages[''].dependencies[HTML] =
        'file:dependency-train/payload/unexpected-extension.tgz';
    data.candidate.packages[`node_modules/${HTML}`].resolved =
        'file:dependency-train/payload/unexpected-extension.tgz';

    assert.throws(() => check(data), /html-extension.*dependency edge was added or removed/);
});

test('an opt-in CLI declaration must use its exact archive path', () => {
    for (const spec of ['^1.0.0', 'file:dependency-train/payload/algolia-extension.tgz']) {
        const data = optInFixture();
        data.candidate.packages[''].dependencies[HTML] = spec;

        assert.throws(() => check(data), /html-extension.*dependency edge was added or removed/);
    }
});

test('a new opt-in archive cannot fall back to the registry resolution', () => {
    const data = optInFixture();
    data.candidate.packages[`node_modules/${HTML}`] = metadata(HTML, '1.0.0', {
        'opt-parser': '^2.0.0',
    });

    assert.throws(() => check(data), /Archive resolution mismatch.*html-extension/);
});

test('a new opt-in archive preserves unrelated CLI runtime and development identities', () => {
    for (const name of ['stable', 'tool']) {
        const data = optInFixture();
        data.candidate.packages[`node_modules/${name}`].integrity = 'sha512-unrelated-drift';

        assert.throws(() => check(data), /Unplanned CLI dependency delta.*resolution changed/);
    }
});

test('a new opt-in subtree must match its exact canonical source identity', () => {
    for (const field of ['version', 'resolved', 'integrity']) {
        const data = optInFixture();
        data.candidate.packages['node_modules/opt-parser'][field] += '-changed';

        assert.throws(() => check(data), /Canonical source lock html-extension.*opt-parser/);
    }
});

test('modeled runtime imports cannot resolve to a shadowed noncanonical build dependency', () => {
    const data = optInFixture('folding-headings-extension');
    const nested = 'node_modules/@diplodoc/folding-headings-extension/node_modules/@diplodoc/utils';
    data.candidate.packages[nested] = metadata('@diplodoc/utils', '0.9.0');

    assert.throws(() => check(data), /Modeled runtime input.*resolution changed/);
});

function modeledArchiveFixture() {
    const data = optInFixture('folding-headings-extension');
    const utils = node('utils', {'modeled-child': '^1.0.0'});
    const utilsName = utils.manifest.name;
    data.plan.graph.push(utils);
    data.plan.selected.push(utils);

    for (const lock of [data.baseline, data.candidate]) {
        lock.packages[`node_modules/${utilsName}`] = metadata(
            utilsName,
            '1.0.0',
            utils.manifest.dependencies,
        );
        lock.packages['node_modules/modeled-child'] = metadata('modeled-child', '1.0.0');
    }

    data.candidate.packages[''].dependencies[utilsName] = 'file:dependency-train/payload/utils.tgz';
    data.candidate.packages[`node_modules/${utilsName}`] = archived(
        'utils',
        utils.manifest.dependencies,
    );
    data.locks.set(
        'utils',
        source(utils.manifest.dependencies, {
            'node_modules/modeled-child': metadata('modeled-child', '1.0.0'),
        }),
    );
    const foldingLock = data.locks.get('folding-headings-extension');
    foldingLock.packages[`node_modules/${utilsName}`].dependencies = utils.manifest.dependencies;
    foldingLock.packages['node_modules/modeled-child'] = metadata('modeled-child', '1.0.0');
    const nested = 'node_modules/@diplodoc/folding-headings-extension/node_modules/@diplodoc/utils';
    data.candidate.packages[nested] = archived('utils', utils.manifest.dependencies);

    return {...data, nested};
}

test('modeled runtime replacement archives validate every nested canonical subtree', () => {
    const data = modeledArchiveFixture();
    data.candidate.packages[`${data.nested}/node_modules/modeled-child`] = metadata(
        'modeled-child',
        '1.9.0',
    );

    assert.throws(
        () => check(data),
        /Canonical source lock utils.*modeled-child.*resolution changed/,
    );
});

test('modeled runtime replacement archives accept canonical nested and hoisted subtrees', () => {
    const data = modeledArchiveFixture();

    assert.equal(check(data), true);
    data.candidate.packages[`${data.nested}/node_modules/modeled-child`] = metadata(
        'modeled-child',
        '1.0.0',
    );
    assert.equal(check(data), true);
});

test('modeled runtime discovery checks archive cycle-closing identities without recursing forever', () => {
    const data = modeledArchiveFixture();
    const utils = '@diplodoc/utils';
    const closing = {[utils]: '^1.0.0'};
    const dependencies = {'modeled-child': '^1.0.0'};

    for (const lock of [data.baseline, data.candidate, ...data.locks.values()]) {
        if (lock.packages['node_modules/modeled-child']) {
            lock.packages['node_modules/modeled-child'].dependencies = closing;
        }
    }
    data.locks.get('utils').packages[`node_modules/${utils}`] = metadata(
        utils,
        '1.0.0',
        dependencies,
    );
    const nestedChild = `${data.nested}/node_modules/modeled-child`;
    data.candidate.packages[nestedChild] = metadata('modeled-child', '1.0.0', closing);
    assert.equal(check(data), true);

    data.candidate.packages[`${nestedChild}/node_modules/${utils}`] = metadata(
        utils,
        '1.0.0',
        dependencies,
    );
    assert.throws(() => check(data), /Canonical source lock utils.*archive does not match/);
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
