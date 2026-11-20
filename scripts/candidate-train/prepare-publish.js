'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const {OWNER, REPO, SHA, github, pages, fileAt, read} = require('./common');
const {planTrain} = require('./plan');
const {applyRefresh, refreshOptions} = require('./refresh');
const {BOT, preparedBranch, isPreparedSource} = require('./prepare-policy');
const {assertPreparedCI} = require('./prepare-ci');
const {assertNoCompetingPull} = require('./prepare-plan');
const {readPolicy, canonicalInputs, validateProposal} = require('./prepare-lock');

async function currentMaster(request, {repo, baseSha}) {
    const current = await request(`/repos/${OWNER}/${repo}/branches/master`);
    assert.equal(current.commit.sha, baseSha, `${repo}: master advanced; rerun Refresh`);
}

async function publishLock(item, dependency, bot, request, appRequest, botRequest) {
    const prefix = `/repos/${OWNER}/${item.repo}`;
    const branch = preparedBranch(dependency);
    await currentMaster(request, item);
    const competing = await pages(`${prefix}/pulls?state=open&base=master`, request);
    const readSource = (repo, sha, file) => fileAt(repo, sha, file, request);
    await assertNoCompetingPull(item.repo, dependency.name, competing, readSource, request);

    // Never recreate deliberately closed PRs for this target.
    const previous = await pages(
        `${prefix}/pulls?state=all&head=${OWNER}:${encodeURIComponent(branch)}`,
        request,
    );
    assert.equal(previous.length, 0, `${item.repo}: a PR already exists for this branch`);
    const base = await request(`${prefix}/git/commits/${item.baseSha}`);
    const tree = await appRequest(`${prefix}/git/trees`, {
        method: 'POST',
        body: {
            base_tree: base.tree.sha,
            tree: [
                {
                    path: 'package-lock.json',
                    mode: '100644',
                    type: 'blob',
                    content: JSON.stringify(item.lock, null, 2) + '\n',
                },
            ],
        },
    });
    assert.match(tree.sha, SHA);
    const title = `chore(deps): align ${dependency.name} at ${dependency.version}`;
    const commit = await appRequest(`${prefix}/git/commits`, {
        method: 'POST',
        body: {
            message: title,
            tree: tree.sha,
            parents: [item.baseSha],
            author: {name: BOT, email: `${bot.id}+${BOT}@users.noreply.github.com`},
        },
    });
    let head = commit.sha;
    assert.match(head, SHA);
    try {
        await currentMaster(request, item);
        await appRequest(`${prefix}/git/refs`, {
            method: 'POST',
            body: {ref: `refs/heads/${branch}`, sha: head},
        });
    } catch (error) {
        if (error.status !== 422) throw error;
        const ref = await request(`${prefix}/git/ref/heads/${branch}`);
        head = ref.object.sha;
        assert.match(head, SHA);
        const existing = await request(`${prefix}/git/commits/${head}`);
        assert.deepEqual(
            existing.parents.map(({sha}) => sha),
            [item.baseSha],
        );
        assert.equal(existing.tree.sha, tree.sha, 'Existing branch has a different lockfile');
    }
    await currentMaster(request, item);
    const pr = await botRequest(`${prefix}/pulls`, {
        method: 'POST',
        body: {
            head: branch,
            base: 'master',
            draft: false,
            title,
            body: 'This lockfile update completes a coordinated dependency group. The manifest ranges are preserved. Morning checks this exact head and the other group members before any candidate build.',
        },
    });
    assert.ok(isPreparedSource(pr));
    assert.equal(pr.head.sha, head);
    assert.equal(pr.head.repo?.full_name, `${OWNER}/${item.repo}`);
    assert.equal(pr.base.sha, item.baseSha);
    return pr.number;
}

async function publishPreparation(plan, locks, env, request = github, hooks = {}) {
    assert.equal(env.GITHUB_REPOSITORY, `${OWNER}/infra`);
    assert.equal(env.GITHUB_REF, 'refs/heads/master');
    assert.equal(plan.toolSha, env.GITHUB_SHA);
    const options = refreshOptions(env);
    assert.ok(options.prepareMissing);
    const {canonicalPlan = planTrain, refresh = applyRefresh, checkCI = assertPreparedCI} = hooks;
    const reader = (route, options) => request(route, {...options, token: env.GH_TOKEN});
    const botRequest = (route, options) =>
        request(route, {...options, token: env.TRAIN_REFRESH_TOKEN});
    const appRequest = (route, options) =>
        request(route, {...options, token: env.TRAIN_GROUP_APP_TOKEN});
    const canonical = await canonicalPlan(env, reader, undefined, options);
    assert.equal(canonical.metapackageSha, plan.metapackageSha);
    assert.deepEqual(canonical.group, plan.group, 'Selection changed; rerun Refresh');

    const {group} = canonical;
    assert.ok(group?.missing?.length && group.missing.length === locks.length);
    assert.equal(env.DEPENDENCY_TRAIN_MISSING_REPOS, group.missing.map(({repo}) => repo).join(','));
    const registry = readPolicy();
    for (const [i, item] of locks.entries()) {
        assert.match(item.repo, REPO);
        assert.match(item.baseSha, SHA);
        assert.deepEqual({repo: item.repo, baseSha: item.baseSha}, group.missing[i]);
        await currentMaster(reader, item);
        await checkCI(item.repo, item.baseSha, reader);
        const [manifest, lock] = await canonicalInputs(item, reader);
        validateProposal(
            item,
            group,
            JSON.parse(manifest),
            JSON.parse(lock),
            item.lock,
            registry,
            env.DEPENDENCY_TRAIN_MAX_RISK || 'low',
        );
    }

    const bot = await botRequest('/user');
    assert.equal(bot.login, BOT);
    assert.ok(Number.isSafeInteger(bot.id) && bot.id > 0);
    const report = hooks.report || (() => {});
    await refresh(canonical, botRequest, undefined, (item, sha, result) =>
        report(`${item.repo}#${item.number} @ ${sha}: ${result}`),
    );
    for (const item of locks) {
        const number = await publishLock(
            item,
            group.dependency,
            bot,
            reader,
            appRequest,
            botRequest,
        );
        report(`Opened https://github.com/${OWNER}/${item.repo}/pull/${number}`);
    }
}

if (require.main === module) {
    publishPreparation(
        read('dependency-refresh-plan.json'),
        read('dependency-refresh-locks.json'),
        process.env,
        github,
        {report: (message) => fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- ${message}\n`)},
    ).catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = {publishPreparation};
