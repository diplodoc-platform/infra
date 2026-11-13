const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {apiFixture} = require('../helpers/candidate-api');
const {parseCohort} = require('../../scripts/candidate-train/cohort');
const {planTrain, assess, renderSelection} = require('../../scripts/candidate-train/plan');
const {planId, validatePlan, buildOrder, write} = require('../../scripts/candidate-train/common');
const {revalidateSources} = require('../../scripts/candidate-train/publish');
const {verifyCohortInput} = require('../../scripts/candidate-train/build');

const tests = [];
const test = (name, fn) => tests.push({name, fn});
const root = path.join(__dirname, '../..');
const SHA = 'a'.repeat(40);

function fixture() {
    const api = apiFixture();
    api.graph.find((node) => node.repo === 'beta').manifest.dependencies = {'@diplodoc/alpha': '*'};
    api.pulls = ['alpha', 'beta', 'gamma', 'delta'].map((repo, i) => api.addPull(repo, i + 1));
    for (const pr of api.pulls) pr.user.login = 'maintainer';
    api.env = {
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_SHA: SHA,
        DEPENDENCY_TRAIN_COHORT_PRS: 'gamma#3,beta#2,alpha#1,delta#4',
        DEPENDENCY_TRAIN_COHORT_DEPENDENCY: '@types/example',
    };
    return api;
}

async function select(api, env = api.env) {
    const cwd = process.cwd();
    process.chdir(root);
    try {
        return await planTrain(env, api.request, api.evidence);
    } finally {
        process.chdir(cwd);
    }
}

test('cohort accepts more than three exact human PRs and orders dependencies before consumers', async () => {
    const api = fixture();
    const plan = await select(api);
    assert.equal(plan.schema, 2);
    assert.equal(plan.selected.length, 4);
    assert.deepEqual(plan.cohort.dependency, {name: '@types/example', version: '1.1.0'});
    const order = buildOrder(plan.graph, plan.selected).map((node) => node.repo);
    assert.ok(order.indexOf('alpha') < order.indexOf('beta'));
    assert.equal(order.at(-1), 'cli');
    assert.match(renderSelection(plan), /indivisible/);
    const legacy = {...plan, schema: 1};
    delete legacy.cohort;
    legacy.id = planId(legacy);
    assert.throws(() => validatePlan(legacy));
});

test('manual grouping rejects duplicate repositories, malformed identities and excluded roots', () => {
    for (const value of [
        '',
        'utils#1,utils#2',
        'utils#0',
        '../utils#1',
        'utils#1;echo x',
        'cli#1',
        'vsc#1',
        Array.from({length: 41}, (_, i) => `p${i}#1`).join(','),
    ]) {
        assert.throws(() => parseCohort(value));
    }
});

test('scheduled runs cannot use cohorts or bypass manual source approval', async () => {
    const api = fixture();
    await assert.rejects(
        select(api, {...api.env, GITHUB_EVENT_NAME: 'schedule'}),
        /manual dispatch/,
    );
    await assert.rejects(select(api, {...api.env, DEPENDENCY_TRAIN_WAVE: '2'}), /indivisible/);
});

test('a shared dependency cohort cannot omit another registered direct consumer', async () => {
    const api = fixture();
    await assert.rejects(
        select(api, {...api.env, DEPENDENCY_TRAIN_COHORT_PRS: 'alpha#1,beta#2,gamma#3'}),
        /every registered consumer/,
    );
});

test('one stale, closed or forked PR blocks the whole group instead of reducing it', async () => {
    for (const mutate of [
        (pr) => {
            pr.base.sha = SHA;
        },
        (pr) => {
            pr.state = 'closed';
        },
        (pr) => {
            pr.head.repo.full_name = 'outsider/alpha';
        },
    ]) {
        const api = fixture();
        mutate(api.pulls[0]);
        await assert.rejects(select(api));
    }
});

test('a missing exact-head CI result blocks every member of a cohort', async () => {
    const api = fixture();
    api.evidence.fetchCheckRuns = async () => ({check_runs: []});
    await assert.rejects(select(api), /exact-head CI is not green/);
});

test('cohort source locks must resolve the same exact shared version', async () => {
    const api = fixture();
    const pr = api.pulls[0];
    const before = api.graph[0].manifest;
    const after = {...before, devDependencies: {'@types/example': '^1.1.0'}};
    api.addFiles('alpha', pr.head.sha, {
        'package.json': after,
        'package-lock.json': {
            lockfileVersion: 3,
            packages: {'': after, 'node_modules/@types/example': {version: '1.2.0', dev: true}},
        },
    });
    await assert.rejects(select(api), /different versions/);
});

test('cycles reject the assembled group before any build or publication', async () => {
    const api = fixture();
    const alpha = api.pulls[0];
    const before = {
        ...api.graph[0].manifest,
        dependencies: {'@diplodoc/beta': '*'},
        devDependencies: {'@types/example': '^1.0.0'},
    };
    const after = {...before, devDependencies: {'@types/example': '^1.1.0'}};
    for (const [sha, manifest, version] of [
        [alpha.base.sha, before, '1.0.0'],
        [alpha.head.sha, after, '1.1.0'],
    ]) {
        api.addFiles('alpha', sha, {
            'package.json': manifest,
            'package-lock.json': {
                lockfileVersion: 3,
                packages: {'': manifest, 'node_modules/@types/example': {version, dev: true}},
            },
        });
    }
    await assert.rejects(select(api), /cycle/);
});

test('publisher independently reselects the exact manually approved group', async () => {
    const api = fixture();
    const plan = await select(api);
    const cwd = process.cwd();
    process.chdir(root);
    try {
        await revalidateSources(plan, api.env, api.request, api.evidence);
        await assert.rejects(
            revalidateSources(
                plan,
                {...api.env, DEPENDENCY_TRAIN_COHORT_PRS: 'alpha#1'},
                api.request,
                api.evidence,
            ),
            /exact cohort/,
        );
        const tampered = structuredClone(plan);
        tampered.cohort.dependency.version = '1.2.0';
        tampered.id = planId(tampered);
        await assert.rejects(
            revalidateSources(tampered, api.env, api.request, api.evidence),
            /cohort changed/,
        );
        api.pulls[0].state = 'closed';
        await assert.rejects(revalidateSources(plan, api.env, api.request, api.evidence));
    } finally {
        process.chdir(cwd);
    }
});

test('a coordinated direct override may follow only the approved dependency declaration', () => {
    const pr = {
        number: 1,
        state: 'open',
        draft: false,
        user: {login: 'maintainer'},
        base: {ref: 'master', repo: {name: 'client'}},
        head: {sha: SHA, repo: {full_name: 'diplodoc-platform/client'}},
    };
    const before = {
        name: '@diplodoc/client',
        version: '1.0.0',
        devDependencies: {'@types/example': '^1.0.0'},
        overrides: {'@types/example': '^1.0.0'},
    };
    const after = {
        ...before,
        devDependencies: {'@types/example': '^1.1.0'},
        overrides: {'@types/example': '^1.1.0'},
    };
    const lock = (manifest, version) => ({
        lockfileVersion: 3,
        packages: {'': manifest, 'node_modules/@types/example': {version, dev: true}},
    });
    const args = [
        pr,
        [{filename: 'package.json', status: 'modified'}],
        before,
        after,
        lock(before, '1.0.0'),
        lock(after, '1.1.0'),
        [],
    ];
    assert.doesNotThrow(() => assess(...args, {manual: true, dependency: '@types/example'}));
    assert.throws(() => assess(...args));
    after.overrides.unrelated = '2.0.0';
    assert.throws(
        () => assess(...args, {manual: true, dependency: '@types/example'}),
        /Non-dependency/,
    );
});

test('the common dev build input and its transitive tree retain exact canonical versions', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cohort-input-'));
    const plan = {
        cohort: {dependency: {name: '@types/example', version: '1.1.0'}},
        selected: [{repo: 'alpha'}],
    };
    const lock = {
        lockfileVersion: 3,
        packages: {
            '': {devDependencies: {'@types/example': '^1.1.0'}},
            'node_modules/@types/example': {version: '1.1.0', dependencies: {nested: '^2.0.0'}},
            'node_modules/nested': {version: '2.0.0'},
        },
    };
    for (const [name, version, dependencies] of [
        ['@types/example', '1.1.0', {nested: '^2.0.0'}],
        ['nested', '2.0.0', {}],
    ]) {
        const target = path.join(directory, 'node_modules', name);
        fs.mkdirSync(target, {recursive: true});
        write(path.join(target, 'package.json'), {name, version, dependencies});
    }
    verifyCohortInput(plan, {repo: 'alpha'}, lock, directory);
    write(path.join(directory, 'node_modules/nested/package.json'), {
        name: 'nested',
        version: '2.1.0',
    });
    assert.throws(() => verifyCohortInput(plan, {repo: 'alpha'}, lock, directory), /mismatch/);
    fs.rmSync(directory, {recursive: true, force: true});
});

module.exports = {tests};
