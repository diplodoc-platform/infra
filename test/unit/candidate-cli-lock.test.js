const assert = require('node:assert/strict');
const {assembleCliLock} = require('../../scripts/candidate-train/cli-lock');

const tests = [];
const test = (name, fn) => tests.push({name, fn});
const pkg = (version, dependencies) => ({
    version,
    resolved: `https://registry.npmjs.org/pkg/${version}.tgz`,
    integrity: `sha512-${version}`,
    ...(dependencies ? {dependencies} : {}),
});
function fixture() {
    const manifest = {
        name: '@diplodoc/cli',
        version: '1.0.0',
        dependencies: {'@diplodoc/leaf': 'file:dependency-train/payload/leaf.tgz'},
    };
    const source = {name: '@diplodoc/leaf', version: '1.0.0', dependencies: {shared: '^1.0.0'}};
    const baseline = {
        lockfileVersion: 3,
        packages: {
            '': {...manifest, dependencies: {'@diplodoc/leaf': '^1.0.0'}},
            'node_modules/@diplodoc/leaf': pkg('1.0.0', source.dependencies),
            'node_modules/shared': pkg('1.0.0'),
            'node_modules/tool': pkg('1.0.0', {shared: '^1.0.0'}),
        },
    };
    baseline.packages[''].devDependencies = {tool: '^1.0.0'};
    manifest.devDependencies = {tool: '^1.0.0'};
    const lock = {lockfileVersion: 3, packages: {'': source, 'node_modules/shared': pkg('1.1.0')}};
    const archive = {repo: 'leaf', manifest: source, lock};
    const archives = new Map([[source.name, archive]]);
    return {manifest, source, baseline, archive, archives};
}
const assemble = (f) =>
    assembleCliLock(f.baseline, f.manifest, f.archives, () => Buffer.from('archive'));

test('assembly copies canonical source identities while leaving immutable CLI nodes and inputs unchanged', () => {
    const f = fixture();
    const before = structuredClone(f);
    const candidate = assemble(f);
    assert.deepEqual(f, before);
    assert.deepEqual(
        candidate.packages['node_modules/shared'],
        f.baseline.packages['node_modules/shared'],
    );
    assert.deepEqual(
        candidate.packages['node_modules/tool'],
        f.baseline.packages['node_modules/tool'],
    );
    assert.deepEqual(
        candidate.packages['node_modules/@diplodoc/leaf/node_modules/shared'],
        f.archive.lock.packages['node_modules/shared'],
    );
    assert.equal(
        candidate.packages['node_modules/@diplodoc/leaf'].resolved,
        f.manifest.dependencies[f.source.name],
    );
    assert.match(candidate.packages['node_modules/@diplodoc/leaf'].integrity, /^sha512-/);
});

function peerFixture() {
    const f = fixture();
    f.source.peerDependencies = {react: '^1.0.0'};
    f.archive.lock.packages[''].peerDependencies = f.source.peerDependencies;
    f.baseline.packages['node_modules/react'] = pkg('1.0.0', {shared: '^1.0.0'});
    f.archive.lock.packages['node_modules/react'] = pkg('1.0.0', {shared: '^1.0.0'});
    return f;
}

test('a source peer must preserve both the frozen CLI provider and its complete dependency tree', () => {
    const f = peerFixture();
    assert.throws(() => assemble(f), /Cannot preserve frozen CLI peer react/);
    f.archive.lock.packages['node_modules/shared'] = pkg('1.0.0');
    const candidate = assemble(f);
    assert.deepEqual(
        candidate.packages['node_modules/react'],
        f.baseline.packages['node_modules/react'],
    );
    assert.equal(candidate.packages['node_modules/@diplodoc/leaf/node_modules/react'], undefined);
    f.archive.lock.packages['node_modules/react'].version = '1.1.0';
    assert.throws(() => assemble(f), /source 1.1.0, CLI 1.0.0/);
});

test('an absent optional source peer still uses the independently verified frozen host context', () => {
    const f = peerFixture();
    delete f.archive.lock.packages['node_modules/react'];
    assert.throws(() => assemble(f), /Missing canonical peer/);
    f.source.peerDependenciesMeta = {react: {optional: true}};
    const candidate = assemble(f);
    assert.deepEqual(
        candidate.packages['node_modules/react'],
        f.baseline.packages['node_modules/react'],
    );
    assert.equal(candidate.packages['node_modules/@diplodoc/leaf/node_modules/react'], undefined);
});

test('missing canonical packages, links and unsafe locations are rejected before npm', () => {
    for (const mutate of [
        (f) => delete f.archive.lock.packages['node_modules/shared'],
        (f) => {
            f.archive.lock.packages['node_modules/shared'].link = true;
        },
        (f) => {
            f.baseline.packages['node_modules/../escape'] = pkg('1.0.0');
        },
        (f) => {
            f.archive.lock.packages[''].dependencies = {['__proto__']: '1.0.0'};
        },
    ]) {
        const f = fixture();
        mutate(f);
        assert.throws(() => assemble(f));
    }
});
module.exports = {tests};

test('valid dotted npm scopes remain accepted without permitting path traversal', () => {
    const f = fixture();
    f.archive.lock.packages[''].dependencies = {'@jsonjoy.com/base64': '^1'};
    f.archive.lock.packages['node_modules/@jsonjoy.com/base64'] = pkg('1.0.0');
    const candidate = assembleCliLock(
        f.baseline,
        f.manifest,
        f.archives,
        () => Buffer.from('archive'),
        true,
    );
    assert.equal(
        candidate.packages['node_modules/@diplodoc/leaf/node_modules/@jsonjoy.com/base64'].version,
        '1.0.0',
    );
    f.archive.lock.packages[''].dependencies = {'@scope/../../outside': '1.0.0'};
    assert.throws(() =>
        assembleCliLock(f.baseline, f.manifest, f.archives, () => Buffer.from('archive'), true),
    );
});
