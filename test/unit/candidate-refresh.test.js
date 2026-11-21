const assert = require('node:assert/strict');
const path = require('node:path');
const {apiFixture} = require('../helpers/candidate-api');
const {planTrain} = require('../../scripts/candidate-train/plan');
const {assertNoCompetingPull} = require('../../scripts/candidate-train/prepare-plan');
const {preparedBranch} = require('../../scripts/candidate-train/prepare-policy');
const {applyRefresh} = require('../../scripts/candidate-train/refresh');

const tests = [];
const test = (name, fn) => tests.push({name, fn});
const sha = (character) => character.repeat(40);
const namespace = 'diplodoc-platform';
const env = {
    GITHUB_EVENT_NAME: 'schedule',
    GITHUB_SHA: sha('a'),
    DEPENDENCY_TRAIN_SELECTION_MODE: 'cohort',
    DEPENDENCY_TRAIN_REPOSITORIES: 'all',
};

async function select(api, variables = env, {refresh = true, ...options} = {}) {
    const cwd = process.cwd();
    process.chdir(path.join(__dirname, '../..'));

    try {
        return await planTrain(variables, api.request, api.evidence, {refresh, ...options});
    } finally {
        process.chdir(cwd);
    }
}

test('Refresh checks stale PRs against the current package version rather than the old PR version', async () => {
    const api = apiFixture();
    const stale = api.addPull('alpha', 1, {stale: true});
    api.addPull('beta', 2);
    const alpha = api.graph.find(({repo}) => repo === 'alpha');
    const current = {
        ...alpha.manifest,
        version: '1.0.1',
        devDependencies: {'@types/example': '^1.0.0'},
    };
    const lock = (manifest) => ({
        lockfileVersion: 3,
        packages: {'': manifest, 'node_modules/@types/example': {version: '1.0.0'}},
    });
    api.addFiles('alpha', alpha.sha, {'package.json': current, 'package-lock.json': lock(current)});

    const plan = await select(api);
    assert.equal(plan.group.dependency.name, '@types/example');
    assert.equal(plan.group.sources[0].sha, stale.head.sha);
    assert.equal(plan.group.sources[0].refreshTo, alpha.sha);
    assert.equal((await select(api, env, {refresh: false})).selected.length, 0);

    const request = api.request;
    api.request = async (route) =>
        route.endsWith('/alpha/branches/master') ? {commit: {sha: sha('e')}} : request(route);
    api.addFiles('alpha', sha('e'), {'package.json': {...current, version: '1.0.2'}});

    const unsynced = await select(api);
    assert.equal(unsynced.group, null);
    assert.match(unsynced.excluded[0].reason, /Update metapackage submodules/);

    api.addFiles('alpha', sha('e'), {'package.json': {...current, devDependencies: {}}});
    assert.match((await select(api)).excluded[0].reason, /no longer a direct dependency/);
});

test('refresh selects stale PRs only in a complete group and Morning still requires current heads', async () => {
    const api = apiFixture();
    const stale = api.addPull('alpha', 1, {stale: true});
    api.addPull('beta', 2);
    const plan = () => select(api);

    assert.equal((await plan()).group.dependency.name, '@types/example');
    assert.deepEqual(
        (await plan()).group.sources.map((item) => [item.repo, Boolean(item.refreshTo)]),
        [
            ['alpha', true],
            ['beta', false],
        ],
    );
    assert.equal((await select(api, env, {refresh: false})).selected.length, 0);
    assert.equal((await select(api, {...env, DEPENDENCY_TRAIN_REPOSITORIES: 'alpha'})).group, null);

    stale.rebaseable = false;
    assert.equal((await plan()).group, null);
    stale.rebaseable = true;
    stale.commits = 2;
    assert.equal((await plan()).group, null);
});

function installFixture(api, repo, name, range = '^1.0.0') {
    const item = api.graph.find((node) => node.repo === repo);
    item.manifest.devDependencies[name] = range;
    api.addFiles(repo, item.sha, {
        'package.json': item.manifest,
        'package-lock.json': {
            lockfileVersion: 3,
            packages: {'': item.manifest, [`node_modules/${name}`]: {version: '1.0.0', dev: true}},
        },
    });
}

test('prepares only one viable group, honours ranges and leaves default Refresh unchanged', async () => {
    const api = apiFixture();
    api.addPull('alpha', 1);
    api.addPull('beta', 2, {dependency: '@types/other'});
    installFixture(api, 'gamma', '@types/example', '~1.0.0');
    installFixture(api, 'delta', '@types/other');

    assert.equal((await select(api)).group, null);
    const result = await select(api, env, {prepareMissing: true});
    assert.equal(result.group.dependency.name, '@types/other');
    assert.deepEqual(
        result.group.missing.map(({repo}) => repo),
        ['delta'],
    );
    assert.match(result.preparationBlocked[0].reason, /ranges do not allow/);
    const targeted = await select(api, env, {prepareMissing: true, target: '@types/example@1.1.0'});
    assert.equal(targeted.group, null);
    assert.match(targeted.preparationBlocked[0].reason, /ranges do not allow/);

    installFixture(api, 'gamma', '@types/example');
    api.requests.length = 0;
    const first = await select(api, env, {prepareMissing: true});
    assert.equal(first.group.dependency.name, '@types/example');
    assert.deepEqual(
        first.group.missing.map(({repo}) => repo),
        ['gamma'],
    );
    assert.ok(!api.requests.some((route) => route.includes('/delta/pulls?state=all')));
});

test('does not duplicate a pending update with the same dependency, even if CI is red', async () => {
    const api = apiFixture();
    api.addPull('alpha', 1);
    const existing = api.addPull('beta', 2);
    existing.user.login = 'someone';
    const options = {prepareMissing: true};

    const plan = await select(api, env, options);
    assert.equal(plan.group, null);
    assert.match(plan.preparationBlocked[0].reason, /beta#2 already changes/);
});

test('a stale PR touching an unrelated lock entry does not reserve an update from newer master', async () => {
    const name = 'example';
    const manifest = JSON.stringify({devDependencies: {example: '^1.0.0'}});
    const [current, base, head] = [sha('a'), sha('b'), sha('c')];
    const lock = {
        [current]: {'node_modules/example': {version: '1.1.0'}},
        [base]: {'node_modules/example': {version: '1.0.0'}},
        [head]: {
            'node_modules/example': {version: '1.0.0'},
            'node_modules/unrelated': {version: '2.0.0'},
        },
    };
    const pr = {number: 1, base: {sha: current}, head: {sha: head}};
    const read = (_repo, sha, file) =>
        file === 'package.json' ? manifest : JSON.stringify({packages: lock[sha]});
    const request = async (route) =>
        route.includes('/compare/')
            ? {merge_base_commit: {sha: base}}
            : [{filename: 'package-lock.json'}];
    await assertNoCompetingPull('alpha', name, [pr], read, request);

    lock[head]['node_modules/example'].version = '1.2.0';
    await assert.rejects(
        assertNoCompetingPull('alpha', name, [pr], read, request),
        /alpha#1 already changes example/,
    );
});

test('Morning requires green exact-head CI and the bot identity for a prepared PR', async () => {
    const api = apiFixture();
    const dependency = {name: '@types/example', version: '1.1.0'};
    api.addPull('alpha', 1);
    const prepared = api.addPull('beta', 2, {prepared: preparedBranch(dependency)});
    const selectMorning = () => select(api, env, {refresh: false});
    assert.deepEqual(
        (await selectMorning()).selected.map(({repo}) => repo),
        ['alpha', 'beta'],
    );

    const existingCheck = api.evidence.fetchCheckRuns;
    api.evidence.fetchCheckRuns = (...args) =>
        args[2] === 'beta' ? {check_runs: []} : existingCheck(...args);
    assert.equal((await selectMorning()).selected.length, 0);
    const pending = await select(api, env, {prepareMissing: true});
    assert.equal(pending.group, null);
    assert.match(pending.preparationBlocked[0].reason, /prepared PR already exists/);

    api.evidence.fetchCheckRuns = existingCheck;
    prepared.user.login = 'someone';
    assert.equal((await selectMorning()).selected.length, 0);
    prepared.user.login = 'diplodoc-bot';
    prepared.head.repo = {full_name: 'diplodoc-bot/beta', fork: true};
    assert.equal((await selectMorning()).selected.length, 0);

    prepared.head.repo = {full_name: `${namespace}/beta`};
    prepared.state = 'closed';
    const result = await select(api, env, {prepareMissing: true});
    assert.equal(result.group, null);
    assert.match(result.preparationBlocked[0].reason, /prepared PR already exists/);
});

function applicationFixture() {
    const prefix = `/repos/${namespace}`;
    const first = {repo: 'alpha', number: 1, sha: sha('a'), baseSha: sha('b'), refreshTo: sha('c')};
    const second = {repo: 'beta', number: 2, sha: sha('d'), baseSha: sha('e')};
    const third = {repo: 'gamma', number: 3, sha: sha('1'), baseSha: sha('2'), refreshTo: sha('3')};
    const sources = [first, second, third];
    const metapackageSha = sha('4');
    const masters = new Map(sources.map((item) => [item.repo, item.refreshTo || item.baseSha]));
    masters.set('diplodoc', metapackageSha);
    masters.set('delta', sha('6'));
    const writes = [];
    const verified = [];
    const rules = new Map();
    const refreshed = new Map([
        [first.repo, sha('5')],
        [third.repo, sha('7')],
    ]);
    const pr = (item) => {
        const repo = {full_name: `${namespace}/${item.repo}`};
        return {
            number: item.number,
            node_id: `PR_${item.repo}`,
            state: 'open',
            draft: false,
            user: {login: 'dependabot[bot]'},
            head: {sha: item.sha, ref: 'dependabot/npm_and_yarn/example', repo},
            base: {sha: item.baseSha, ref: 'master', repo},
            rebaseable: true,
            commits: 1,
        };
    };
    const plan = {metapackageSha, group: {sources, baseline: [{repo: 'delta', sha: sha('6')}]}};
    return {
        first,
        masters,
        rules,
        writes,
        verified,
        plan,
        request: async (route, options) => {
            if (route === '/user') return {login: 'diplodoc-bot'};
            for (const [repo, value] of masters)
                if (route === `${prefix}/${repo}/branches/master`) return {commit: {sha: value}};
            for (const item of sources)
                if (route === `${prefix}/${item.repo}/pulls/${item.number}`) return pr(item);
            for (const item of sources)
                if (route === `${prefix}/${item.repo}/commits/${item.sha}`)
                    return {sha: item.sha, author: {login: 'dependabot[bot]'}};
            if (route.includes('/rules/branches/')) return rules.get(route) || [];
            assert.equal(route, '/graphql');
            assert.equal(options.method, 'POST');
            assert.match(options.body.query, /updateMethod: REBASE/);
            const item = sources.find((item) => options.body.variables.id === `PR_${item.repo}`);
            assert.ok(item.refreshTo);
            assert.equal(options.body.variables.head, item.sha);
            writes.push(item.repo);
            return {
                data: {
                    updatePullRequestBranch: {
                        pullRequest: {
                            number: item.number,
                            headRefOid: refreshed.get(item.repo),
                            baseRefOid: item.refreshTo,
                        },
                    },
                },
            };
        },
        prepare: (_directory, item) => async (head) => {
            assert.equal(head, refreshed.get(item.repo));
            verified.push(item.repo);
        },
    };
}

test('preflights the complete group and verifies each stale source after the exact-head rebase', async () => {
    const f = applicationFixture();
    await applyRefresh(f.plan, f.request, f.prepare);
    assert.deepEqual(f.writes, ['alpha', 'gamma']);
    assert.deepEqual(f.verified, f.writes);
});

test('a moved fresh peer, moved baseline, or conflicting patch prevents any write', async () => {
    for (const repo of ['beta', 'delta', 'gamma']) {
        const f = applicationFixture();
        if (repo !== 'gamma') f.masters.set(repo, sha('f'));
        const prepare = (directory, item) => {
            if (repo === 'gamma' && item.repo === repo) throw Error('conflict in expected tree');
            return f.prepare(directory, item);
        };
        await assert.rejects(applyRefresh(f.plan, f.request, prepare));
        assert.deepEqual(f.writes, []);
    }
});

test('requires a manual refresh if a source or target ruleset requires signed commits', async () => {
    for (const ref of ['master', 'dependabot/npm_and_yarn/example']) {
        const f = applicationFixture();
        f.rules.set(`/repos/${namespace}/alpha/rules/branches/${encodeURIComponent(ref)}`, [
            {type: 'required_signatures'},
        ]);
        await assert.rejects(applyRefresh(f.plan, f.request, f.prepare), /requires signed commits/);
        assert.deepEqual(f.writes, []);
    }
});

test('tree proof failure stops the group before the next PR is updated', async () => {
    const f = applicationFixture();
    await assert.rejects(
        applyRefresh(f.plan, f.request, () => async () => {
            throw Error('Rebase changed the expected tree');
        }),
        /expected tree/,
    );
    assert.deepEqual(f.writes, ['alpha']);
});

module.exports = {tests};
