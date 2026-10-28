const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {modeledRuntimeLock} = require('../../scripts/candidate-train/build-inputs');
const {buildEdges, MODELED_RUNTIME_INPUTS} = require('../../scripts/candidate-train/model');
const {buildOrder} = require('../../scripts/candidate-train/common');
const {verifyModeledRuntimeInputs} = require('../../scripts/candidate-train/build');

const tests = [];
const test = (name, fn) => tests.push({name, fn});

function fixture() {
    const node = {
        repo: 'folding-headings-extension',
        manifest: {
            name: '@diplodoc/folding-headings-extension',
            version: '0.2.5',
            dependencies: {'ordinary-runtime': '^1.0.0'},
            devDependencies: {'@diplodoc/utils': '^2.3.6', 'ordinary-tooling': '^1.0.0'},
        },
    };
    const lock = {
        lockfileVersion: 3,
        packages: {
            '': structuredClone(node.manifest),
            'node_modules/@diplodoc/utils': {
                version: '2.3.6',
                dependencies: {'runtime-leaf': '^1.0.0'},
            },
            'node_modules/runtime-leaf': {version: '1.1.0'},
            'node_modules/ordinary-runtime': {version: '1.0.0'},
            'node_modules/ordinary-tooling': {version: '1.0.0', dev: true},
        },
    };

    return {node, lock};
}

test('modeled runtime view preserves exact canonical resolutions without changing source evidence', () => {
    const {node, lock} = fixture();
    const originalNode = structuredClone(node);
    const originalLock = structuredClone(lock);
    const view = modeledRuntimeLock(node, lock);

    assert.deepEqual(view.packages[''].dependencies, {'@diplodoc/utils': '^2.3.6'});
    assert.equal(view.packages[''].devDependencies, undefined);
    assert.deepEqual(view.packages['node_modules/@diplodoc/utils'], {
        version: '2.3.6',
        dependencies: {'runtime-leaf': '^1.0.0'},
    });
    assert.deepEqual(Object.keys(view.packages), Object.keys(lock.packages));
    view.packages['node_modules/runtime-leaf'].version = '9.0.0';
    assert.deepEqual(lock, originalLock);
    assert.deepEqual(node, originalNode);
});

test('modeled runtime inputs fail closed on missing or inconsistent canonical declarations', () => {
    const mutations = [
        ({node}) => delete node.manifest.devDependencies['@diplodoc/utils'],
        ({lock}) => delete lock.packages[''].devDependencies['@diplodoc/utils'],
        ({lock}) => {
            lock.packages[''].devDependencies['@diplodoc/utils'] = '^1.0.0';
        },
        ({lock}) => delete lock.packages[''],
        ({lock}) => delete lock.packages['node_modules/@diplodoc/utils'],
        ({lock}) => delete lock.packages['node_modules/@diplodoc/utils'].version,
        ({lock}) => {
            lock.packages['node_modules/@diplodoc/utils'].link = true;
        },
    ];

    for (const mutate of mutations) {
        const data = fixture();
        mutate(data);
        assert.throws(
            () => modeledRuntimeLock(data.node, data.lock),
            /[Mm]odeled runtime|canonical lock root/,
        );
    }
});

test('runtime input modeling requires the exact folding repository and package identity', () => {
    const {node} = fixture();

    assert.equal(modeledRuntimeLock({...node, repo: 'other'}, undefined), null);
    assert.equal(
        modeledRuntimeLock(
            {...node, manifest: {...node.manifest, name: '@diplodoc/other'}},
            undefined,
        ),
        null,
    );
    assert.deepEqual(
        MODELED_RUNTIME_INPUTS.map((profile) => profile.dependencies),
        [['@diplodoc/utils']],
    );
});

test('a correctly declared runtime dependency uses the ordinary canonical proof', () => {
    const {node, lock} = fixture();
    const name = '@diplodoc/utils';
    node.manifest.dependencies[name] = node.manifest.devDependencies[name];
    delete node.manifest.devDependencies[name];
    lock.packages[''] = structuredClone(node.manifest);

    assert.equal(modeledRuntimeLock(node, lock), null);
});

test('folding uses the explicit utils build edge without adding unrelated development inputs', () => {
    const {node} = fixture();
    const utils = {repo: 'utils', manifest: {name: '@diplodoc/utils'}};
    const tooling = {repo: 'tooling', manifest: {name: 'ordinary-tooling'}};
    const cli = {
        repo: 'cli',
        manifest: {name: '@diplodoc/cli', dependencies: {'@diplodoc/utils': '^2.3.6'}},
    };
    const graph = [node, utils, tooling, cli];

    assert.deepEqual(buildEdges(graph, [node])(node), ['@diplodoc/utils']);
    assert.deepEqual(
        buildOrder(graph, [node, utils]).map((entry) => entry.repo),
        ['utils', 'folding-headings-extension', 'cli'],
    );
    assert.deepEqual(
        buildOrder(graph, [utils]).map((entry) => entry.repo),
        ['utils', 'cli'],
    );
});

test('installed modeled inputs reject registry fallback and validate each nested archive subtree', () => {
    const {node, lock} = fixture();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-modeled-runtime-'));
    const folding = path.join(root, 'node_modules', node.manifest.name);
    const utils = path.join(folding, 'node_modules', '@diplodoc/utils');
    const leaf = path.join(utils, 'node_modules', 'runtime-leaf');
    const sha = 'a'.repeat(40);
    const replacementLock = {
        lockfileVersion: 3,
        packages: {
            '': {version: '2.3.6', dependencies: {'runtime-leaf': '^1.0.0'}},
            'node_modules/runtime-leaf': {version: '1.1.0'},
        },
    };
    const archives = new Map([['@diplodoc/utils', {sha, lock: replacementLock}]]);
    const write = (directory, manifest) => {
        fs.mkdirSync(directory, {recursive: true});
        fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify(manifest));
    };

    try {
        write(utils, {name: '@diplodoc/utils', version: '2.3.6'});
        write(leaf, {name: 'runtime-leaf', version: '1.1.0'});
        assert.throws(
            () => verifyModeledRuntimeInputs(root, folding, node, lock, archives),
            /fell back to a registry package/,
        );
        write(utils, {
            name: '@diplodoc/utils',
            version: '2.3.6',
            dependencyTrain: {sourceSha: sha},
        });
        verifyModeledRuntimeInputs(root, folding, node, lock, archives);
        write(leaf, {name: 'runtime-leaf', version: '9.9.9'});
        assert.throws(
            () => verifyModeledRuntimeInputs(root, folding, node, lock, archives),
            /Locked resolution mismatch/,
        );
    } finally {
        fs.rmSync(root, {recursive: true, force: true});
    }
});

module.exports = {tests};
