const assert = require('node:assert/strict');
const path = require('node:path');
const {createHash} = require('node:crypto');
const planner = require('../../scripts/candidate-train/plan');
const {candidateWaves, repositoryTargets} = require('../../scripts/candidate-train/waves');
const {planId, validatePlan} = require('../../scripts/candidate-train/common');

const tests = [];
const test = (name, fn) => tests.push({name, fn});
const SHA = 'a'.repeat(40);
const root = path.join(__dirname, '../..');
const hash = (value) => createHash('sha1').update(value).digest('hex');
const node = (repo, dependencies = {}, devDependencies = {}) => ({
    repo,
    sha: hash(repo),
    manifest: {name: `@diplodoc/${repo}`, version: '1.0.0', dependencies, devDependencies},
});
const candidate = (repo, number, day = number) => ({
    repo,
    number,
    createdAt: `2026-10-${String(day).padStart(2, '0')}T00:00:00.000Z`,
});

function apiFixture() {
    const graph = ['alpha', 'beta', 'gamma', 'delta', 'unrelated'].map((repo) => node(repo));
    graph.push(
        node('cli', Object.fromEntries(graph.slice(0, 4).map((item) => [item.manifest.name, '*']))),
    );
    const files = new Map();
    const trees = new Map();
    const pulls = new Map();
    const requests = [];
    const checkCalls = [];
    const prefix = '/repos/diplodoc-platform/';

    function addFiles(repo, sha, contents) {
        const tree = Object.entries(contents).map(([filename, value]) => {
            const bytes = typeof value === 'string' ? value : JSON.stringify(value);
            const blob = hash(`${repo}:${sha}:${filename}`);
            files.set(`${repo}:${blob}`, {
                encoding: 'base64',
                size: bytes.length,
                content: Buffer.from(bytes).toString('base64'),
            });
            return {path: filename, type: 'blob', sha: blob};
        });
        trees.set(`${repo}:${sha}`, {truncated: false, tree});
    }

    for (const item of graph) {
        addFiles(item.repo, item.sha, {'package.json': item.manifest});
        pulls.set(item.repo, []);
    }

    addFiles('diplodoc', SHA, {
        '.gitmodules': graph
            .map(
                (item) =>
                    `[submodule "${item.repo}"]\n path = packages/${item.repo}\n url = git@github.com:diplodoc-platform/${item.repo}.git\n`,
            )
            .join(''),
    });

    function addPull(repo, number, options = {}) {
        const base = graph.find((item) => item.repo === repo);
        const before = {...base.manifest, devDependencies: {'@types/example': '^1.0.0'}};
        const after = {...before, devDependencies: {'@types/example': '^1.1.0'}};
        const lock = (manifest, version) => ({
            lockfileVersion: 3,
            packages: {'': manifest, 'node_modules/@types/example': {version, dev: true}},
        });
        const sha = hash(`${repo}#${number}`);
        addFiles(repo, base.sha, {
            'package.json': before,
            'package-lock.json': lock(before, '1.0.0'),
        });
        addFiles(repo, sha, {'package.json': after, 'package-lock.json': lock(after, '1.1.0')});
        const pr = {
            number,
            state: 'open',
            draft: false,
            created_at: candidate(repo, number, options.day || number).createdAt,
            user: {login: 'dependabot[bot]'},
            base: {ref: 'master', repo: {name: repo}, sha: options.stale ? SHA : base.sha},
            head: {sha, repo: {full_name: `diplodoc-platform/${repo}`}},
        };
        pulls.get(repo).push(pr);
        return pr;
    }

    const request = async (route) => {
        requests.push(route);
        assert.ok(route.startsWith(prefix), 'No unexpected host');
        const url = new URL(route, 'https://api.github.com');
        const [, , , repo, ...parts] = url.pathname.split('/');

        if (parts.join('/') === 'branches/master') {
            return {
                commit: {
                    sha: repo === 'diplodoc' ? SHA : graph.find((item) => item.repo === repo).sha,
                },
            };
        }
        if (
            repo === 'diplodoc' &&
            parts.join('/') === `git/trees/${SHA}` &&
            url.searchParams.get('recursive')
        ) {
            return {
                truncated: false,
                tree: graph.map((item) => ({
                    path: `packages/${item.repo}`,
                    type: 'commit',
                    sha: item.sha,
                })),
            };
        }
        if (parts[0] === 'git' && parts[1] === 'trees')
            return structuredClone(trees.get(`${repo}:${parts[2]}`));
        if (parts[0] === 'git' && parts[1] === 'blobs')
            return structuredClone(files.get(`${repo}:${parts[2]}`));
        if (parts[0] === 'pulls' && parts[2] === 'files')
            return [{filename: 'package-lock.json', status: 'modified'}];
        if (parts.length === 1 && parts[0] === 'pulls') {
            const offset = (Number(url.searchParams.get('page')) - 1) * 100;
            return structuredClone(pulls.get(repo).slice(offset, offset + 100));
        }

        assert.fail(`Unexpected request ${route}`);
    };
    const evidence = {
        fetchCheckRuns: async (_token, _owner, repo, sha) => {
            checkCalls.push(`${repo}:${sha}`);
            return {
                check_runs: [
                    {
                        id: 1,
                        name: 'Quality',
                        app: {id: 15368},
                        head_sha: sha,
                        status: 'completed',
                        conclusion: 'success',
                    },
                ],
            };
        },
        fetchRequiredChecks: async () => [{context: 'Quality', appId: 15368}],
    };

    return {graph, addPull, request, evidence, requests, checkCalls};
}

async function plan(fixture, env = {}) {
    const original = process.cwd();
    process.chdir(root);

    try {
        return await planner.planTrain(
            {GITHUB_SHA: SHA, DEPENDENCY_TRAIN_REPOSITORIES: 'all', ...env},
            fixture.request,
            fixture.evidence,
        );
    } finally {
        process.chdir(original);
    }
}

test('all discovers every reachable package but excludes unrelated registered repositories', () => {
    const graph = [
        node('alpha'),
        node('beta'),
        node('client', {}, {'@diplodoc/beta': '*'}),
        node('unrelated'),
        node('cli', {'@diplodoc/alpha': '*', '@diplodoc/client': '*'}),
    ];
    const result = repositoryTargets(graph, ['all']);

    assert.deepEqual(result.repositories, ['alpha', 'beta', 'client']);
    assert.deepEqual(result.unsupported, [
        {repo: 'unrelated', reason: 'Package is outside the CLI build graph'},
    ]);
    assert.throws(() => repositoryTargets(graph, ['missing']), /Unregistered target/);
    assert.throws(() => repositoryTargets(graph, ['unrelated']), /not in the CLI build graph/);
});

test('wave inventory is deterministic, complete, bounded and never combines same-repository PRs', () => {
    const inventory = [
        candidate('alpha', 4),
        candidate('alpha', 1),
        candidate('delta', 5),
        candidate('beta', 2),
        candidate('gamma', 3),
    ];
    const waves = candidateWaves(inventory);

    assert.deepEqual(
        waves.map((wave) => wave.map((item) => `${item.repo}#${item.number}`)),
        [
            ['alpha#1', 'beta#2', 'gamma#3'],
            ['alpha#4', 'delta#5'],
        ],
    );
    assert.deepEqual(candidateWaves([...inventory].reverse()), waves);
    assert.equal(waves.flat().length, inventory.length);
    assert.ok(
        waves.every(
            (wave) =>
                wave.length <= 3 && new Set(wave.map((item) => item.repo)).size === wave.length,
        ),
    );
    assert.throws(
        () => candidateWaves([candidate('alpha', 1), candidate('alpha', 1)]),
        /Duplicate source PR/,
    );
    assert.throws(
        () =>
            candidateWaves(Array.from({length: 2001}, (_, index) => candidate('alpha', index + 1))),
        /size limit/,
    );
});

test('all inventories later PRs and selects only the requested wave into the source graph', async () => {
    const fixture = apiFixture();
    fixture.addPull('alpha', 1);
    fixture.addPull('alpha', 4);
    fixture.addPull('beta', 2);
    fixture.addPull('gamma', 3);
    fixture.addPull('delta', 5);
    const result = await plan(fixture, {DEPENDENCY_TRAIN_WAVE: '2'});

    assert.deepEqual(
        result.selected.map((item) => `${item.repo}#${item.number}`),
        ['alpha#4', 'delta#5'],
    );
    assert.equal(result.inventory.length, 5);
    assert.equal(fixture.checkCalls.length, 5);
    assert.deepEqual(result.selection, {
        wave: 2,
        totalWaves: 2,
        waveSize: 3,
        eligibleCount: 5,
        repositories: ['alpha', 'beta', 'delta', 'gamma'],
        unsupported: [{repo: 'unrelated', reason: 'Package is outside the CLI build graph'}],
    });
    assert.equal(result.graph.find((item) => item.repo === 'alpha').sha, hash('alpha#4'));
    assert.equal(result.graph.find((item) => item.repo === 'beta').sha, hash('beta'));
    assert.equal(result.id, planId(result));
    assert.equal(validatePlan(result), result);
    const summary = planner.renderSelection(result);
    assert.match(summary, /Wave \*\*2\/2\*\*/);
    assert.match(summary, /Wave 1: alpha#1, beta#2, gamma#3/);
    assert.match(summary, /independent, not cumulative/);
    assert.match(summary, /no automatic advance or merge/);
});

test('explicit lists larger than a wave are accepted without expanding selected past three', async () => {
    const fixture = apiFixture();
    for (const [index, repo] of ['alpha', 'beta', 'gamma', 'delta'].entries())
        fixture.addPull(repo, index + 1);
    const result = await plan(fixture, {DEPENDENCY_TRAIN_REPOSITORIES: 'alpha,beta,gamma,delta'});

    assert.equal(result.selected.length, 3);
    assert.equal(result.inventory.length, 4);
    assert.equal(result.waves.length, 2);
});

test('low-only inventory excludes medium/high/critical dependency updates', () => {
    const pr = {
        user: {login: 'dependabot[bot]'},
        state: 'open',
        draft: false,
        base: {ref: 'master', repo: {name: 'alpha'}},
        head: {sha: SHA, repo: {full_name: 'diplodoc-platform/alpha'}},
    };
    const files = [{filename: 'package-lock.json', status: 'modified'}];
    const lock = (manifest, version) => ({
        lockfileVersion: 3,
        packages: {
            '': manifest,
            [`node_modules/${Object.keys(manifest.dependencies)[0]}`]: {version},
        },
    });

    for (const dependency of ['vitest', 'js-yaml', 'jsonwebtoken']) {
        const before = {name: '@diplodoc/alpha', dependencies: {[dependency]: '^1.0.0'}};
        const after = {...before, dependencies: {[dependency]: '^1.1.0'}};
        assert.throws(
            () =>
                planner.assess(
                    pr,
                    files,
                    before,
                    after,
                    lock(before, '1.0.0'),
                    lock(after, '1.1.0'),
                    [],
                ),
            /Only low-risk/,
        );
    }
});

test('empty inventory is not a successful verification and only permits wave one', async () => {
    const fixture = apiFixture();
    const result = await plan(fixture);

    assert.deepEqual(result.selected, []);
    assert.deepEqual(result.waves, []);
    assert.equal(result.selection.totalWaves, 0);
    assert.match(planner.renderSelection(result), /No candidate has been validated/);
    assert.match(planner.renderSelection(result), /No eligible waves/);
    assert.doesNotMatch(planner.renderSelection(result), /1\/0/);
    await assert.rejects(plan(fixture, {DEPENDENCY_TRAIN_WAVE: '2'}), /out of range/);
});

test('stale source PRs are reported and invalid wave inputs fail before API access', async () => {
    const fixture = apiFixture();
    fixture.addPull('alpha', 1, {stale: true});
    const result = await plan(fixture);
    assert.match(result.excluded[0].reason, /Refresh the PR/);

    for (const wave of ['0', '-1', '1.5', 'NaN', '9007199254740992']) {
        await assert.rejects(
            planner.planTrain(
                {DEPENDENCY_TRAIN_REPOSITORIES: 'all', DEPENDENCY_TRAIN_WAVE: wave},
                async () => assert.fail('Invalid wave cannot access the API'),
            ),
            /Invalid wave number/,
        );
    }

    await assert.rejects(
        planner.planTrain(
            {DEPENDENCY_TRAIN_REPOSITORIES: 'all', DEPENDENCY_TRAIN_PR_NUMBER: '1'},
            async () => assert.fail('Ambiguous exact PR cannot access the API'),
        ),
        /An exact PR requires one repository/,
    );
});

test('full inventory keeps exact-head publisher and source-date requirements', async () => {
    for (const failure of ['wrong-head', 'wrong-publisher', 'skipped', 'missing-date']) {
        const fixture = apiFixture();
        const pr = fixture.addPull('alpha', 1);

        if (failure === 'missing-date') {
            delete pr.created_at;
        } else {
            fixture.evidence.fetchCheckRuns = async () => ({
                check_runs: [
                    {
                        id: 1,
                        name: 'Quality',
                        app: {id: failure === 'wrong-publisher' ? 123 : 15368},
                        head_sha: failure === 'wrong-head' ? SHA : pr.head.sha,
                        status: 'completed',
                        conclusion: failure === 'skipped' ? 'skipped' : 'success',
                    },
                ],
            });
        }

        const result = await plan(fixture);

        assert.deepEqual(result.selected, []);
        assert.deepEqual(result.inventory, []);
        assert.equal(result.excluded.length, 1);
        assert.match(
            result.excluded[0].reason,
            failure === 'missing-date' ? /Invalid source PR date/ : /Required exact-head CI/,
        );
    }
});

test('large selection summaries are bounded and point to the complete inventory artifact', async () => {
    const fixture = apiFixture();
    const result = await plan(fixture);
    result.waves = Array.from({length: 102}, (_, index) => [{repo: 'alpha', number: index + 1}]);
    result.selection.totalWaves = 102;
    result.excluded = Array.from({length: 102}, (_, index) => ({
        repo: 'beta',
        number: index + 1,
        reason: 'Needs a refresh',
    }));

    const summary = planner.renderSelection(result);

    assert.match(summary, /Showing 100\/102 waves/);
    assert.match(summary, /Showing 100\/102 exclusions/);
    assert.doesNotMatch(summary, /alpha#101|beta#101/);
    assert.match(summary, /dependency-train-plan.*train-plan.json/);
});

module.exports = {tests};
