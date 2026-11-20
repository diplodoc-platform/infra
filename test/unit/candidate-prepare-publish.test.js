const assert = require('node:assert/strict');
const path = require('node:path');
const {apiFixture} = require('../helpers/candidate-api');
const {assertPreparedCI} = require('../../scripts/candidate-train/prepare-ci');
const {preparedBranch} = require('../../scripts/candidate-train/prepare-policy');
const {publishPreparation} = require('../../scripts/candidate-train/prepare-publish');

const tests = [];
const test = (name, fn) => tests.push({name, fn});
const root = path.join(__dirname, '../..');
const dependency = {name: '@types/example', version: '1.1.0'};
const branch = preparedBranch(dependency);
const sha = (character) => character.repeat(40);

function fixture() {
    const api = apiFixture();
    const missing = api.graph
        .filter(({repo}) => ['alpha', 'beta'].includes(repo))
        .map(({repo, sha: baseSha}) => ({repo, baseSha}));
    const locks = missing.map((item) => {
        const {manifest} = api.graph.find(({repo}) => repo === item.repo);
        manifest.devDependencies[dependency.name] = '^1.0.0';
        const key = `node_modules/${dependency.name}`;
        const oldLock = {lockfileVersion: 3, packages: {'': manifest, [key]: {version: '1.0.0'}}};
        api.addFiles(item.repo, item.baseSha, {
            'package.json': manifest,
            'package-lock.json': oldLock,
        });
        const lock = structuredClone(oldLock);
        lock.packages[key] = {
            version: dependency.version,
            resolved: 'https://registry.npmjs.org/@types/example/-/example-1.1.0.tgz',
            integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
            dev: true,
        };
        return {...item, lock};
    });
    const plan = {toolSha: sha('a'), metapackageSha: sha('b'), group: {dependency, missing}};
    const env = {
        GITHUB_REPOSITORY: 'diplodoc-platform/infra',
        GITHUB_REF: 'refs/heads/master',
        GITHUB_SHA: plan.toolSha,
        DEPENDENCY_TRAIN_PREPARE_MISSING: 'true',
        DEPENDENCY_TRAIN_MISSING_REPOS: 'alpha,beta',
        GH_TOKEN: 'reader',
        TRAIN_REFRESH_TOKEN: 'bot',
        TRAIN_GROUP_APP_TOKEN: 'app',
    };
    const writes = [];
    const reports = [];
    const reviewedCI = new Set(missing.map(({repo}) => repo));
    const request = async (route, {method = 'GET', token, body}) => {
        const [, , owner, repo, ...parts] = route.split('/');
        const item = missing.find((item) => item.repo === repo);

        if (method === 'POST') {
            writes.push({route, token, body});
            if (parts[0] === 'git') {
                assert.equal(owner, 'diplodoc-platform');
                assert.equal(token, 'app');
                return {sha: sha(parts[1] === 'trees' ? 'c' : 'd')};
            }
            assert.equal(parts[0], 'pulls');
            assert.equal(owner, 'diplodoc-platform');
            assert.equal(token, 'bot');
            return {
                number: 10,
                user: {login: 'diplodoc-bot'},
                head: {
                    sha: sha('d'),
                    ref: branch,
                    repo: {full_name: `diplodoc-platform/${repo}`},
                },
                base: {sha: item.baseSha, repo: {name: repo}},
            };
        }

        if (route === '/user') {
            assert.equal(token, 'bot');
            return {login: 'diplodoc-bot', id: 17};
        }
        assert.equal(token, 'reader');
        if (parts.join('/') === `git/commits/${item.baseSha}`) return {tree: {sha: sha('e')}};
        return api.request(route);
    };

    async function run() {
        const cwd = process.cwd();
        process.chdir(root);
        try {
            return await publishPreparation(plan, locks, env, request, {
                canonicalPlan: () => plan,
                refresh: () => {},
                checkCI: (repo) => assert.ok(reviewedCI.has(repo), 'CI has not been reviewed'),
                report: (message) => reports.push(message),
            });
        } finally {
            process.chdir(cwd);
        }
    }
    return {run, plan, env, locks, reviewedCI, writes, reports};
}

test('validates every missing lock and its reviewed workflows before the first write', async () => {
    const extraDelta = fixture();
    extraDelta.locks[1].lock.packages['node_modules/unrelated'] = {version: '2.0.0'};
    await assert.rejects(extraDelta.run(), /Unrelated lockfile entries changed/);
    assert.deepEqual(extraDelta.writes, []);

    const invalidCI = fixture();
    invalidCI.reviewedCI.delete('beta');
    await assert.rejects(invalidCI.run(), /CI has not been reviewed/);
    assert.deepEqual(invalidCI.writes, []);

    const nonMaster = fixture();
    nonMaster.env.GITHUB_REF = 'refs/heads/topic';
    await assert.rejects(nonMaster.run());
    assert.deepEqual(nonMaster.writes, []);
});

test('publishes only the missing lockfiles for the selected group in its source repositories', async () => {
    const f = fixture();
    await f.run();
    assert.equal(f.writes.length, 8);
    for (const [i, {repo}] of f.plan.group.missing.entries()) {
        const [tree, commit, ref, pr] = f.writes.slice(i * 4, i * 4 + 4);
        assert.deepEqual(
            tree.body.tree.map(({path}) => path),
            ['package-lock.json'],
        );
        assert.deepEqual(commit.body.parents, [f.plan.group.missing[i].baseSha]);
        assert.equal(ref.body.ref, `refs/heads/${branch}`);
        assert.equal(pr.route, `/repos/diplodoc-platform/${repo}/pulls`);
        assert.equal(pr.body.head, branch);
    }
    assert.equal(f.reports.length, 2);
});

test('repository workflow changes fail before prepared CI can run', async () => {
    const request = async (route) => {
        assert.equal(
            route,
            `/repos/diplodoc-platform/components/git/trees/${sha('d')}?recursive=1`,
        );
        return {
            truncated: false,
            tree: [{path: '.github/workflows', type: 'tree', sha: sha('e')}],
        };
    };
    await assert.rejects(
        assertPreparedCI('components', sha('d'), request),
        /differs from the reviewed/,
    );
    await assert.rejects(assertPreparedCI('alpha', sha('d'), request), /has not been reviewed/);
});

module.exports = {tests};
