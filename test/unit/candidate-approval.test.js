const assert = require('node:assert/strict');
const {approveVerified} = require('../../scripts/candidate-train/approve');
const {approvalRepositories} = require('../../scripts/candidate-train/approval-scope');
const {fixture} = require('./candidate-merge.test');

const tests = [];
const test = (name, fn) => tests.push({name, fn});

function approvalFixture(repositories = 'alpha,beta') {
    const f = fixture();
    const reviews = new Map();
    const writes = [];
    for (const {repo} of f.plan.selected) {
        const pr = f.pulls.get(repo);
        pr.user = {login: 'dependabot[bot]'};
        pr.head.ref = 'dependabot/npm_and_yarn/shared-1.1.0';
        reviews.set(repo, []);
    }
    const env = {
        ...f.environment,
        GITHUB_REPOSITORY: 'diplodoc-platform/infra',
        GITHUB_REF: 'refs/heads/master',
        GITHUB_ACTOR: 'diplodoc-app[bot]',
        CANDIDATE_SHA: f.candidate.sha,
        VERIFIER_CHECK_ID: '10',
        DEPENDENCY_TRAIN_BOT_APPROVAL_REPOSITORIES: repositories,
    };
    const request = (route, options) => {
        const repo = route.split('/')[3];
        if (route.includes('/files?')) {
            return [{filename: 'package-lock.json', status: 'modified'}];
        }
        if (route.includes('/reviews?')) return reviews.get(repo);
        return f.request(route, options);
    };
    const bot = async (route, options) => {
        if (route === '/user') return {login: 'diplodoc-bot'};

        const repo = route.split('/')[3];
        const {method, body} = options;
        assert.equal(method, 'POST');
        assert.equal(body.event, 'APPROVE');
        assert.equal(body.commit_id, f.pulls.get(repo).head.sha);
        const review = {
            user: {login: 'diplodoc-bot'},
            state: 'APPROVED',
            commit_id: body.commit_id,
        };
        reviews.get(repo).push(review);
        writes.push(route);
        return review;
    };

    return {f, env, writes, run: () => approveVerified(env, request, bot, f.evidence)};
}

test('approved train reviews exact Dependabot heads only once', async () => {
    const {run, writes} = approvalFixture();
    const initial = await run();
    assert.equal(initial.length, 2);
    assert.ok(initial.every(({alreadyApproved}) => !alreadyApproved));
    assert.ok((await run()).every(({alreadyApproved}) => alreadyApproved));
    assert.equal(writes.length, 2);
    assert.ok(writes.every((route) => route.endsWith('/reviews')));
});

test('all approves a verified group of supported repositories', async () => {
    const {run, writes} = approvalFixture('all');

    assert.deepEqual(
        (await run()).map(({repo}) => repo),
        ['alpha', 'beta'],
    );
    assert.equal(writes.length, 2);
});

test('all uses the build graph and preserves approval exclusions', () => {
    const {plan} = fixture();
    for (const repo of ['algolia-extension', 'vsc', 'infra', 'unrelated']) {
        const name = `@diplodoc/${repo}`;
        plan.graph.push({repo, manifest: {name, version: '1.0.0'}});
        if (repo !== 'unrelated') plan.cli.manifest.dependencies[name] = '*';
    }

    assert.deepEqual(
        [...approvalRepositories(' all ', plan.graph)],
        ['algolia-extension', 'alpha', 'beta'],
    );
    assert.deepEqual([...approvalRepositories('cli,vsc,infra,alpha', plan.graph)], ['alpha']);
    assert.equal(approvalRepositories('', plan.graph).size, 0);
    assert.throws(() => approvalRepositories('alpha,all', plan.graph), /cannot be combined/);
});

for (const [name, mutate, error, repositories] of [
    [
        'new head',
        ({f}) => {
            f.pulls.get('beta').head.sha = '9'.repeat(40);
        },
        /Expected values/,
    ],
    [
        'new CLI baseline',
        ({f}) => {
            f.cliBase = '9'.repeat(40);
        },
        /cli baseline changed/,
    ],
    [
        'red CI',
        ({f}) => {
            f.badCi = 'beta';
        },
        /exact-head CI/,
        'all',
    ],
    [
        'new Internal Check',
        ({f}) => {
            f.checks.push({...f.checks[0], id: 11});
        },
        /superseded/,
    ],
    [
        'closed candidate',
        ({f}) => {
            f.pulls.get('cli').state = 'closed';
        },
        /candidate is closed/,
    ],
    [
        'bot-owned PR',
        ({f}) => {
            f.pulls.get('beta').user.login = 'diplodoc-bot';
        },
        /native Dependabot/,
    ],
    [
        'review requested changes',
        ({f}) => {
            f.review = 'CHANGES_REQUESTED';
        },
        /requested changes/,
    ],
    [
        'pilot disabled',
        ({env}) => {
            env.DEPENDENCY_TRAIN_BOT_APPROVAL_REPOSITORIES = '';
        },
        /pilot repository list/,
    ],
    [
        'outside pilot scope',
        ({env}) => {
            env.DEPENDENCY_TRAIN_BOT_APPROVAL_REPOSITORIES = 'alpha';
        },
        /outside/,
    ],
    [
        'wrong actor',
        ({env}) => {
            env.GITHUB_ACTOR = 'someone';
        },
        /diplodoc-app/,
    ],
]) {
    test(`approval writes nothing after ${name}`, async () => {
        const context = approvalFixture(repositories);
        mutate(context);
        await assert.rejects(context.run(), error);
        assert.deepEqual(context.writes, []);
    });
}

module.exports = {tests};
