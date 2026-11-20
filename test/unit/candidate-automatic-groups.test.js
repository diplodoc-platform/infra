const assert = require('node:assert/strict');
const path = require('node:path');
const {apiFixture} = require('../helpers/candidate-api');
const {planTrain} = require('../../scripts/candidate-train/plan');
const {planId, validatePlan} = require('../../scripts/candidate-train/common');
const {revalidateSources} = require('../../scripts/candidate-train/publish');
const {changedInput, automaticGroups} = require('../../scripts/candidate-train/automatic-groups');

const tests = [];
const test = (name, fn) => tests.push({name, fn});
const env = {
    GITHUB_EVENT_NAME: 'schedule',
    GITHUB_SHA: 'a'.repeat(40),
    DEPENDENCY_TRAIN_SELECTION_MODE: 'cohort',
    DEPENDENCY_TRAIN_REPOSITORIES: 'all',
};
async function inRepository(run) {
    const cwd = process.cwd();
    process.chdir(path.join(__dirname, '../..'));
    try {
        return await run();
    } finally {
        process.chdir(cwd);
    }
}

const select = (api, variables = env) =>
    inRepository(() => planTrain(variables, api.request, api.evidence));
const revalidate = (plan, variables, api) =>
    inRepository(() => revalidateSources(plan, variables, api.request, api.evidence));

test('automatic groups use the complete shared input across more than three repositories', async () => {
    const api = apiFixture();
    for (const [i, repo] of ['alpha', 'beta', 'gamma', 'delta'].entries()) api.addPull(repo, i + 1);
    const plan = await select(api);
    assert.equal(plan.schema, 2);
    assert.equal(plan.selected.length, 4);
    assert.deepEqual(plan.cohort.dependency, {name: '@types/example', version: '1.1.0'});
    await revalidate(plan, env, api);
    const changed = {...env, DEPENDENCY_TRAIN_REPOSITORIES: 'alpha,beta,gamma'};
    await assert.rejects(revalidate(plan, changed, api));
});

test('Morning accepts a complete group with an Any source rule and revalidates its exact heads', async () => {
    const api = apiFixture();
    for (const [i, repo] of ['alpha', 'beta', 'gamma', 'delta'].entries()) api.addPull(repo, i + 1);
    api.evidence.fetchRequiredChecks = async (_token, _owner, repo) => [
        {context: 'Quality', appId: repo === 'delta' ? null : 15368},
    ];

    const plan = await select(api);
    assert.equal(plan.selected.length, 4);
    await revalidate(plan, env, api);

    const currentRuns = api.evidence.fetchCheckRuns;
    api.evidence.fetchCheckRuns = (token, owner, repo, head) =>
        currentRuns(token, owner, repo, repo === 'delta' ? 'b'.repeat(40) : head);
    await assert.rejects(revalidate(plan, env, api));
    assert.deepEqual((await select(api)).selected, []);
});

test('risk defaults to low; automatic fallback prioritizes whole groups and exact dispatch selects one risk', async () => {
    const api = apiFixture();
    api.addPull('alpha', 1, {dependency: 'vitest'});
    api.addPull('beta', 2, {day: 2});
    const fallback = {...env, DEPENDENCY_TRAIN_MAX_RISK: 'critical'};
    const exact = {
        ...env,
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        DEPENDENCY_TRAIN_RISK_LEVEL: 'medium',
    };

    const defaultPlan = await select(api);
    assert.equal(defaultPlan.selected[0].repo, 'beta');
    assert.equal(defaultPlan.automaticGroups.groups.length, 1);

    const fallbackPlan = await select(api, fallback);
    assert.deepEqual(
        fallbackPlan.automaticGroups.groups.map(({risk}) => risk),
        ['low', 'medium'],
    );
    assert.equal(fallbackPlan.selected[0].repo, 'beta');

    const manual = await select(api, exact);
    assert.equal(manual.selected[0].repo, 'alpha');
    assert.equal(manual.selected[0].profile, 'toolchain');
    await revalidate(manual, exact, api);
    await assert.rejects(revalidate(manual, env, api));

    const downgraded = structuredClone(manual);
    Object.assign(downgraded.selected[0], {risk: 'low', profile: 'standard'});
    assert.notEqual(planId(downgraded), manual.id);
    assert.throws(() => validatePlan(downgraded));
    await assert.rejects(select(api, {...fallback, DEPENDENCY_TRAIN_MAX_RISK: 'constructor'}));
    await assert.rejects(select(api, {...exact, GITHUB_EVENT_NAME: 'schedule'}));
});

test('an exact group may combine sources of different risk and keeps the maximum', () => {
    const input = {name: 'shared', version: '1.1.0'};
    const inventory = [
        {repo: 'alpha', number: 1, risk: 'low', createdAt: '2026-11-01'},
        {repo: 'beta', number: 2, risk: 'critical', createdAt: '2026-11-02'},
    ];
    const graph = inventory.map(({repo}) => ({repo, manifest: {dependencies: {shared: '^1'}}}));
    const inputs = new Map(inventory.map(({repo, number}) => [`${repo}#${number}`, input]));
    const {groups} = automaticGroups(graph, inventory, inputs, ['alpha', 'beta']);

    assert.equal(groups[0].risk, 'critical');
    assert.equal(groups[0].requests.length, 2);
});

test('a missing or conflicting consumer blocks the entire automatic group', async () => {
    for (const conflicting of [false, true]) {
        const api = apiFixture();
        for (const [i, repo] of ['alpha', 'beta', 'gamma', 'delta'].entries())
            api.addPull(
                repo,
                i + 1,
                repo === 'delta' ? {targetVersion: conflicting ? '1.2.0' : '1.1.0'} : {},
            );
        if (!conflicting)
            api.evidence.fetchCheckRuns = async (_token, _owner, repo, sha) => ({
                check_runs:
                    repo === 'delta'
                        ? []
                        : [
                              {
                                  id: 1,
                                  name: 'Quality',
                                  app: {id: 15368},
                                  head_sha: sha,
                                  status: 'completed',
                                  conclusion: 'success',
                              },
                          ],
            });
        const plan = await select(api);
        assert.equal(plan.selected.length, 0);
        assert.ok(plan.automaticGroups.excluded.length > 0);
    }
});

test('ambiguity and a narrowed allowlist never silently shrink a group', () => {
    const graph = ['alpha', 'beta'].map((repo) => ({
        repo,
        manifest: {devDependencies: {shared: '^1'}},
    }));
    const item = (repo, number) => ({repo, number, createdAt: '2026-11-01T00:00:00Z'});
    const input = {name: 'shared', version: '1.1.0'};
    const inventory = [item('alpha', 1), item('alpha', 2), item('beta', 3)];
    const inputs = new Map(inventory.map((node) => [`${node.repo}#${node.number}`, input]));
    assert.equal(automaticGroups(graph, inventory, inputs, ['alpha', 'beta']).groups.length, 0);
    assert.equal(automaticGroups(graph, inventory.slice(1), inputs, ['alpha']).groups.length, 0);
});

test('single-input selection rejects grouped changes and floating/prerelease lock versions', () => {
    const pkg = {devDependencies: {one: '^1', two: '^1'}};
    const lock = (one, two) => ({
        packages: {'node_modules/one': {version: one}, 'node_modules/two': {version: two}},
    });
    assert.deepEqual(changedInput(pkg, pkg, lock('1.0.0', '1.0.0'), lock('1.1.0', '1.0.0')), {
        name: 'one',
        version: '1.1.0',
    });
    assert.throws(() => changedInput(pkg, pkg, lock('1.0.0', '1.0.0'), lock('1.1.0', '1.1.0')));
    assert.throws(() =>
        changedInput(pkg, pkg, lock('1.0.0', '1.0.0'), lock('1.1.0-beta.1', '1.0.0')),
    );
});

test('already updated consumers remain frozen in a complete automatic group', async () => {
    const api = apiFixture();
    for (const [i, repo] of ['alpha', 'beta', 'gamma'].entries()) api.addPull(repo, i + 1);
    const delta = api.graph.find((node) => node.repo === 'delta');
    const manifest = {...delta.manifest, devDependencies: {'@types/example': '^1.1.0'}};
    api.addFiles('delta', delta.sha, {
        'package.json': manifest,
        'package-lock.json': {
            lockfileVersion: 3,
            packages: {'': manifest, 'node_modules/@types/example': {version: '1.1.0', dev: true}},
        },
    });
    const plan = await select(api);
    assert.equal(plan.schema, 2);
    assert.equal(plan.selected.length, 3);
    assert.deepEqual(plan.cohort.baseline, [{repo: 'delta', sha: delta.sha}]);
    await revalidate(plan, env, api);
    api.addFiles('delta', delta.sha, {
        'package.json': manifest,
        'package-lock.json': {
            lockfileVersion: 3,
            packages: {'': manifest, 'node_modules/@types/example': {version: '1.0.0', dev: true}},
        },
    });
    await assert.rejects(revalidate(plan, env, api));
});

test('unchanged consumers cannot hide missing target versions or stale master snapshots', () => {
    const graph = ['alpha', 'beta'].map((repo) => ({
        repo,
        sha: repo,
        manifest: {devDependencies: {shared: '^1'}},
    }));
    const item = {repo: 'alpha', number: 1, createdAt: '2026-11-01T00:00:00Z'};
    const inputs = new Map([['alpha#1', {name: 'shared', version: '1.1.0'}]]);
    for (const current of [
        {version: '1.0.0', sha: 'beta'},
        {version: '1.1.0', sha: 'old'},
    ]) {
        assert.equal(
            automaticGroups(graph, [item], inputs, ['alpha'], new Map([['beta:shared', current]]))
                .groups.length,
            0,
        );
    }
});

module.exports = {tests};
