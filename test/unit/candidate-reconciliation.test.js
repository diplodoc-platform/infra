const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {runInNewContext} = require('node:vm');
const yaml = require('js-yaml');
const {automaticGroups} = require('../../scripts/candidate-train/automatic-groups');
const {
    reconciliationBranch,
    reconciliationSeed,
    reconcileLock,
} = require('../../scripts/candidate-train/reconcile-lock');
const {publishReconciliation} = require('../../scripts/candidate-train/reconcile');
const {readReconciledInput} = require('../../scripts/candidate-train/reconcile-source');

const tests = [];
const test = (name, fn) => tests.push({name, fn});
const sha = 'a'.repeat(40);

function entry(name, version, fields = {}) {
    return {
        version,
        resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
        integrity: `sha512-${Buffer.alloc(64, Number(version.at(-1))).toString('base64')}`,
        ...fields,
    };
}

function fixture() {
    const host = {
        dependencies: {shared: '1.2.0'},
        overrides: {parent: {'.': '1.0.0', aux: '2.2.0'}},
    };
    const cli = {
        lockfileVersion: 3,
        packages: {
            '': host,
            'node_modules/shared': entry('shared', '1.2.0'),
            'node_modules/parent': entry('parent', '1.0.0', {dependencies: {aux: '^2.0.0'}}),
            'node_modules/aux': entry('aux', '2.2.0'),
        },
    };
    const before = {
        lockfileVersion: 3,
        packages: {
            '': {dependencies: {primary: '^1', shared: '^1', parent: '^1', independent: '^1'}},
            'node_modules/primary': entry('primary', '1.0.0'),
            'node_modules/shared': entry('shared', '1.1.0'),
            'node_modules/parent': entry('parent', '1.0.0', {
                dependencies: {aux: '^2.0.0', shared: '^1.1'},
            }),
            'node_modules/aux': entry('aux', '2.1.0'),
            'node_modules/independent': entry('independent', '1.0.0', {
                dependencies: {aux: '^1.0.0'},
            }),
            'node_modules/independent/node_modules/aux': entry('aux', '1.0.0'),
        },
    };
    const head = structuredClone(before);
    head.packages['node_modules/primary'] = entry('primary', '1.1.0');
    return {host, cli, before, head};
}

const align = ({before, head, cli, host}) => reconcileLock(before, head, cli, host, 'primary');

test('reconciles a direct pin and a scoped transitive pin, preserving other installations', () => {
    const data = fixture();
    const {lock, changes} = align(data);
    assert.deepEqual(
        changes.map(({name, to}) => [name, to]),
        [
            ['shared', '1.2.0'],
            ['aux', '2.2.0'],
        ],
    );
    assert.deepEqual(
        changes[0].edges.map(({parent}) => parent),
        ['', 'node_modules/parent'],
    );
    assert.deepEqual(
        changes[1].edges.map(({parent}) => parent),
        ['node_modules/parent'],
    );
    assert.equal(lock.packages['node_modules/independent/node_modules/aux'].version, '1.0.0');
    assert.equal(lock.packages['node_modules/primary'].version, '1.1.0');
    const original = structuredClone(lock);
    for (const {key} of changes) original.packages[key] = data.head.packages[key];
    assert.deepEqual(original, data.head);
});

test('refuses incompatible transitive ranges, changed packages, and noncanonical providers', () => {
    const data = fixture();
    data.head.packages['node_modules/parent'].dependencies.shared = '~1.1.0';
    assert.throws(() => align(data), /parent > shared.*excludes 1.2.0/);
    data.head.packages['node_modules/parent'].dependencies.shared = '^1.1';
    data.head.packages['node_modules/shared'] = entry('shared', '1.1.1');
    assert.throws(() => align(data), /already changed by the original PR/);
    data.head.packages['node_modules/shared'] = data.before.packages['node_modules/shared'];
    data.cli.packages['node_modules/shared'].engines = {node: '>=30'};
    assert.throws(() => align(data), /provider changes package metadata/);
    data.cli.packages['node_modules/shared'].resolved = 'https://example.com/shared';
    assert.deepEqual(
        align(data).changes.map(({name}) => name),
        ['aux'],
    );
});

test('blocks a sixth additional package instead of truncating the group', () => {
    const data = fixture();
    for (const name of ['aa', 'bb', 'cc', 'dd']) {
        data.host.dependencies[name] = '1.1.0';
        data.before.packages[`node_modules/${name}`] = entry(name, '1.0.0');
        data.head.packages[`node_modules/${name}`] = entry(name, '1.0.0');
        data.head.packages[''].dependencies[name] = '^1.0.0';
        data.cli.packages[`node_modules/${name}`] = entry(name, '1.1.0');
    }
    assert.throws(() => align(data), /More than five/);
});

test('automatic selection prefers a validated replacement while retaining the original during CI', () => {
    const seed = {repo: 'alpha', number: 10, risk: 'low', createdAt: '2026-11-22'};
    const replacement = {...seed, number: 11, reconciles: 10};
    const input = {name: 'primary', version: '1.1.0'};
    const inputs = new Map([
        ['alpha#10', input],
        ['alpha#11', input],
    ]);
    const graph = [{repo: 'alpha', manifest: {dependencies: {primary: '^1'}}}];
    const choose = (sources) =>
        automaticGroups(graph, sources, inputs, ['alpha']).groups[0].requests[0].number;
    assert.equal(choose([seed]), 10);
    assert.equal(choose([seed, replacement]), 11);
    const pr = {
        number: 11,
        user: {login: 'diplodoc-bot'},
        head: {ref: reconciliationBranch(10, sha)},
    };
    assert.deepEqual(reconciliationSeed(pr), {number: 10, sha});
    assert.equal(reconciliationSeed({...pr, user: {login: 'someone'}}), null);
});

test('revalidates a replacement against the original PR identity and exact lock delta', async () => {
    const {host, cli, before, head} = fixture();
    const {lock} = reconcileLock(before, head, cli, host, 'primary');
    const repo = {name: 'components', full_name: 'diplodoc-platform/components'};
    const base = {sha, ref: 'master', repo};
    const originalHead = 'b'.repeat(40);
    const replacement = {
        number: 11,
        base,
        user: {login: 'diplodoc-bot'},
        head: {ref: reconciliationBranch(10, originalHead), repo},
    };
    const original = {
        number: 10,
        state: 'open',
        draft: false,
        base,
        user: {login: 'dependabot[bot]'},
        head: {sha: originalHead, repo},
    };
    const request = async (route) => {
        if (route.includes('/git/trees/'))
            return {
                truncated: false,
                tree: [
                    {
                        path: '.github/workflows',
                        type: 'tree',
                        sha: '497eb367ebeaa37bc1c4f970b1e6eca06cfde150',
                    },
                ],
            };
        if (route.includes('/files')) return [{filename: 'package-lock.json', status: 'modified'}];
        assert.ok(route.endsWith('/pulls/10'));
        return original;
    };
    const readSource = async (_repo, exactHead, file) => {
        assert.equal(exactHead, originalHead);
        return JSON.stringify(file === 'package.json' ? head.packages[''] : head);
    };
    const verify = (updated = lock) =>
        readReconciledInput(
            replacement,
            before.packages[''],
            head.packages[''],
            before,
            updated,
            {manifest: host},
            cli,
            readSource,
            request,
        );
    assert.deepEqual(await verify(), {
        input: {name: 'primary', version: '1.1.0'},
        seed: 10,
        additional: ['shared', 'aux'],
    });

    await assert.rejects(verify(head), /differs from canonical inputs/);
    original.head.sha = 'c'.repeat(40);
    await assert.rejects(verify(), /Original Dependabot PR changed/);
});

test('reconciliation uses the existing schedule only when independently enabled', () => {
    const workflow = yaml.load(
        fs.readFileSync(
            path.join(__dirname, '../../.github/workflows/dependency-refresh.yml'),
            'utf8',
        ),
    );
    assert.equal(workflow.on.workflow_dispatch.inputs.reconcile.default, false);
    assert.equal(workflow.on.workflow_dispatch.inputs.dry_run.default, true);
    const plan = workflow.jobs.reconcile;
    for (const value of ['', 'false', 'true']) {
        assert.equal(
            runInNewContext(plan.if, {
                github: {event_name: 'schedule'},
                inputs: {},
                vars: {DEPENDENCY_TRAIN_RECONCILE_ENABLED: value},
                needs: {refresh: {result: 'success'}},
                cancelled: () => false,
            }),
            value === 'true',
        );
    }
    assert.ok(!JSON.stringify(plan).includes('secrets.'));
    const publish = workflow.jobs['publish-reconciliation'];
    assert.equal(
        runInNewContext(publish.if, {
            github: {event_name: 'workflow_dispatch', ref: 'refs/heads/master'},
            needs: {reconcile: {outputs: {repositories: 'components'}}},
            inputs: {dry_run: true},
        }),
        false,
    );
});

test('reconciliation never requests write credentials without explicit opt-in and master', async () => {
    const noNetwork = () => assert.fail('Authorization must precede all network calls');
    const env = {GITHUB_REPOSITORY: 'diplodoc-platform/infra', GITHUB_REF: 'refs/heads/master'};
    await assert.rejects(publishReconciliation({}, env, noNetwork), /expected|Expected/);
    await assert.rejects(
        publishReconciliation(
            {},
            {
                ...env,
                GITHUB_REF: 'refs/heads/feature',
                DEPENDENCY_TRAIN_RECONCILE_APPROVED: 'true',
            },
            noNetwork,
        ),
        /refs\/heads\/master/,
    );
});

module.exports = {tests};
