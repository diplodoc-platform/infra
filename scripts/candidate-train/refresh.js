'use strict';

const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');
const {OWNER, REPO, SHA, github, read, write} = require('./common');
const {planTrain} = require('./plan');
const {BOT, isPreparedSource} = require('./prepare-policy');
const {assertPreparedCI} = require('./prepare-ci');

const REBASE = `
mutation Rebase($id: ID!, $head: GitObjectID!) {
  updatePullRequestBranch(input: {
    pullRequestId: $id, expectedHeadOid: $head, updateMethod: REBASE
  }) {
    pullRequest { number headRefOid baseRefOid }
  }
}`;

function git(directory, args) {
    return execFileSync('git', ['-C', directory, ...args], {
        encoding: 'utf8',
        env: {
            PATH: process.env.PATH,
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_TERMINAL_PROMPT: '0',
        },
        timeout: 60_000,
    }).trim();
}

function readTree(directory, sha) {
    return git(directory, ['rev-parse', `${sha}^{tree}`]);
}

function assertOnlyDependencyFiles(directory, base, tree) {
    const files = git(directory, ['diff-tree', '--no-commit-id', '--name-only', '-r', base, tree])
        .split('\n')
        .filter(Boolean);
    assert.ok(
        files.length && files.every((name) => ['package.json', 'package-lock.json'].includes(name)),
        'Expected a nonempty dependency-only patch',
    );
}

function prepareTree(directory, source) {
    const remote = `https://github.com/${OWNER}/${source.repo}.git`;
    git(directory, ['init', '--quiet', '--bare']);
    git(directory, ['fetch', '--quiet', '--no-tags', '--depth=2', remote, source.sha]);
    git(directory, ['fetch', '--quiet', '--no-tags', '--depth=1', remote, source.refreshTo]);
    assert.equal(git(directory, ['rev-parse', `${source.sha}^`]), source.baseSha);
    const author = git(directory, ['show', '-s', '--format=%an%n%ae', source.sha]);

    const tree = git(directory, [
        'merge-tree',
        '--write-tree',
        `--merge-base=${source.baseSha}`,
        source.refreshTo,
        source.sha,
    ]);
    assert.match(tree, SHA);
    assertOnlyDependencyFiles(directory, source.refreshTo, tree);
    return async (sha) => {
        for (let attempt = 1; ; attempt++) {
            try {
                git(directory, ['fetch', '--quiet', '--no-tags', '--depth=2', remote, sha]);
                break;
            } catch (error) {
                if (attempt === 3) throw error;
                await delay(2_000 * attempt);
            }
        }
        assert.equal(git(directory, ['rev-parse', `${sha}^`]), source.refreshTo);
        assert.equal(readTree(directory, sha), tree, 'Rebase changed the expected tree');
        assert.equal(
            git(directory, ['show', '-s', '--format=%an%n%ae', sha]),
            author,
            'Rebase changed the commit author',
        );
    };
}

async function readSource(request, source) {
    assert.match(source.repo, REPO);
    assert.ok(!['cli', 'vsc'].includes(source.repo));
    assert.ok(Number.isSafeInteger(source.number) && source.number > 0);
    assert.match(source.sha, SHA);
    assert.match(source.baseSha, SHA);
    const prefix = `/repos/${OWNER}/${source.repo}`;
    const pr = await request(`${prefix}/pulls/${source.number}`);
    const name = `${source.repo}#${source.number}`;

    assert.equal(pr.number, source.number);
    assert.equal(pr.state, 'open');
    assert.equal(pr.draft, false);
    if (source.prepared) assert.ok(isPreparedSource(pr));
    else assert.equal(pr.user.login, 'dependabot[bot]');
    assert.equal(pr.head.repo.full_name, `${OWNER}/${source.repo}`);
    assert.equal(pr.base.repo.full_name, `${OWNER}/${source.repo}`);
    assert.equal(pr.base.ref, 'master');
    assert.equal(pr.head.sha, source.sha, `${name}: head advanced`);
    assert.equal(pr.base.sha, source.baseSha, `${name}: base advanced`);
    const current = await request(`${prefix}/branches/master`);
    assert.equal(
        current.commit.sha,
        source.refreshTo || source.baseSha,
        `${name}: master advanced`,
    );

    if (source.refreshTo) {
        assert.match(source.refreshTo, SHA);
        if (source.prepared) await assertPreparedCI(source.repo, source.refreshTo, request);
        assert.notEqual(source.refreshTo, source.baseSha);
        assert.ok(source.prepared || pr.head.ref.startsWith('dependabot/'));
        assert.equal(pr.commits, 1);
        assert.equal(pr.rebaseable, true);
        assert.match(pr.node_id, /^PR_[A-Za-z0-9_-]+$/);
        const commit = await request(`${prefix}/commits/${source.sha}`);
        assert.equal(commit.sha, source.sha);
        assert.equal(
            commit.author?.login,
            source.prepared ? BOT : 'dependabot[bot]',
            'Stale head was edited by another author',
        );
        // GitHub's server-side rebase creates an unsigned commit.
        for (const [repo, branch] of [
            [pr.base.repo.full_name, pr.base.ref],
            [pr.head.repo.full_name, pr.head.ref],
        ]) {
            const rules = await request(
                `/repos/${repo}/rules/branches/${encodeURIComponent(branch)}`,
            );
            assert.ok(
                !rules.some((rule) => rule.type === 'required_signatures'),
                `${name}: ${branch} requires signed commits`,
            );
        }
    }
    return pr.node_id;
}

async function applyRefresh(plan, request, prepare = prepareTree, report = () => {}) {
    if (!plan.group) return;
    assert.equal((await request('/user')).login, 'diplodoc-bot');
    const {sources, baseline} = plan.group;
    assert.ok(sources.length && sources.length <= 40);
    assert.equal(new Set(sources.map((item) => item.repo)).size, sources.length);
    const checkBaseline = async () => {
        const metapackage = await request(`/repos/${OWNER}/diplodoc/branches/master`);
        assert.equal(metapackage.commit.sha, plan.metapackageSha, 'Metapackage advanced');
        for (const item of baseline) {
            assert.match(item.repo, REPO);
            assert.match(item.sha, SHA);
            const head = await request(`/repos/${OWNER}/${item.repo}/branches/master`);
            assert.equal(head.commit.sha, item.sha, `${item.repo}: baseline consumer advanced`);
        }
    };

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-refresh-'));
    try {
        const pending = [];
        await checkBaseline();
        for (const [index, source] of sources.entries()) {
            const id = await readSource(request, source);
            if (!source.refreshTo) continue;

            const repoDirectory = fs.mkdtempSync(path.join(directory, `${index}-`));
            const verify = prepare(repoDirectory, source);
            pending.push({source, id, verify});
        }
        for (const {source, id, verify} of pending) {
            await checkBaseline();
            assert.equal(await readSource(request, source), id);
            const result = await request('/graphql', {
                method: 'POST',
                body: {query: REBASE, variables: {id, head: source.sha}},
            });
            assert.ok(
                !result.errors?.length,
                `${source.repo}#${source.number}: ${result.errors?.[0]?.message || 'Rebase failed'}`,
            );
            const pr = result.data?.updatePullRequestBranch?.pullRequest;
            assert.equal(pr?.number, source.number);
            assert.match(pr.headRefOid, SHA);
            assert.notEqual(pr.headRefOid, source.sha);
            report(source, pr.headRefOid, 'Updated by GitHub');
            assert.equal(
                pr.baseRefOid,
                source.refreshTo,
                'GitHub rebased onto an unexpected master',
            );
            await verify(pr.headRefOid);
            report(source, pr.headRefOid, 'Verified identical update; CI pending');
        }
    } finally {
        fs.rmSync(directory, {recursive: true, force: true});
    }
}

async function run(env) {
    const file = 'dependency-refresh-plan.json';
    const summary = (line) => fs.appendFileSync(env.GITHUB_STEP_SUMMARY, line + '\n');
    if (process.argv[2] === 'apply') {
        assert.equal(env.GITHUB_REPOSITORY, `${OWNER}/infra`);
        assert.equal(env.GITHUB_REF, 'refs/heads/master');
        const plan = read(file);
        assert.equal(plan.toolSha, env.GITHUB_SHA);

        await applyRefresh(
            plan,
            (route, options) => github(route, {...options, token: env.TRAIN_REFRESH_TOKEN}),
            prepareTree,
            (item, sha, result) => summary(`- ${item.repo}#${item.number} @ \`${sha}\`: ${result}`),
        );
        return;
    }
    const plan = await planTrain(env, undefined, undefined, refreshOptions(env));
    write(file, plan);
    const missing = plan.group?.missing || [];
    fs.appendFileSync(
        env.GITHUB_OUTPUT,
        `found=${Boolean(plan.group)}\nmissing=${missing.map(({repo}) => repo).join(',')}\n`,
    );
    if (!plan.group) {
        summary('No eligible group selected. See the plan artifact for exclusions.');
        for (const {dependency, reason} of plan.preparationBlocked || [])
            summary(`- ${dependency.name}@${dependency.version}: ${reason}`);
        return;
    }
    const {dependency, risk, sources} = plan.group;
    summary(`### Refresh ${dependency.name}@${dependency.version} (${risk})\n`);
    for (const item of missing) summary(`- ${item.repo}: prepare missing lockfile update`);
    for (const item of sources) {
        summary(
            `- ${item.repo}#${item.number} @ \`${item.sha}\`: ${item.refreshTo ? 'needs rebase' : 'already current'}`,
        );
    }
}

function refreshOptions(env) {
    return {
        refresh: true,
        prepareMissing: env.DEPENDENCY_TRAIN_PREPARE_MISSING === 'true',
        target: env.DEPENDENCY_TRAIN_REFRESH_TARGET || '',
    };
}

if (require.main === module) {
    run(process.env).catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = {applyRefresh, refreshOptions};
