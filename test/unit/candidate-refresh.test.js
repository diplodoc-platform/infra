const assert = require('node:assert/strict');
const {apiFixture} = require('../helpers/candidate-api');
const {planTrain} = require('../../scripts/candidate-train/plan');
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

test('refresh selects stale PRs only in a complete group and Morning still requires current heads', async () => {
    const api = apiFixture();
    const stale = api.addPull('alpha', 1, {stale: true});
    api.addPull('beta', 2);
    const plan = () => planTrain(env, api.request, api.evidence, {refresh: true});

    assert.equal((await plan()).group.dependency.name, '@types/example');
    assert.deepEqual(
        (await plan()).group.sources.map((item) => [item.repo, Boolean(item.refreshTo)]),
        [
            ['alpha', true],
            ['beta', false],
        ],
    );
    assert.equal((await planTrain(env, api.request, api.evidence)).selected.length, 0);
    assert.equal(
        (
            await planTrain(
                {...env, DEPENDENCY_TRAIN_REPOSITORIES: 'alpha'},
                api.request,
                api.evidence,
                {refresh: true},
            )
        ).group,
        null,
    );

    stale.rebaseable = false;
    assert.equal((await plan()).group, null);
    stale.rebaseable = true;
    stale.commits = 2;
    assert.equal((await plan()).group, null);
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
