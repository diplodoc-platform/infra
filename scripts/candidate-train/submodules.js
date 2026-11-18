'use strict';

const assert = require('node:assert/strict');
const {appendFileSync} = require('node:fs');
const {setTimeout: sleep} = require('node:timers/promises');
const {OWNER, SHA, github} = require('./common');

const META = `/repos/${OWNER}/diplodoc`;
const WORKFLOW = 'update-submodules.yml';
const ACTIONS_URL = `https://github.com/${OWNER}/diplodoc/actions`;

async function dispatchUpdate(request) {
    const result = await request(`${META}/actions/workflows/${WORKFLOW}/dispatches`, {
        method: 'POST',
        apiVersion: '2026-03-10',
        body: {ref: 'master'},
    });
    const id = result?.workflow_run_id;
    assert.ok(
        Number.isSafeInteger(id) && id > 0,
        'GitHub did not return an Update Submodules run ID',
    );
    return id;
}

async function waitForUpdate(id, request, {now = Date.now, delay = sleep} = {}) {
    const deadline = now() + 25 * 60_000;

    while (now() < deadline) {
        const run = await request(`${META}/actions/runs/${id}`);
        assert.equal(run.id, id);
        assert.equal(run.path, `.github/workflows/${WORKFLOW}`);
        assert.equal(run.event, 'workflow_dispatch');
        assert.equal(run.head_branch, 'master');
        if (run.status === 'completed') {
            assert.equal(
                run.conclusion,
                'success',
                `Update Submodules finished with ${run.conclusion}`,
            );
            return;
        }

        await delay(Math.min(15_000, Math.max(0, deadline - now())));
    }

    throw new Error('Timed out waiting for Update Submodules');
}

async function closeCandidate({number, sha, trainId}, request) {
    assert.ok(Number.isSafeInteger(number) && number > 0, 'Invalid CLI candidate number');
    assert.match(sha, SHA);
    assert.match(trainId, /^[a-f0-9]{16}$/);
    const route = `/repos/${OWNER}/cli/pulls/${number}`;
    const pr = await request(route);
    assert.equal(pr.merged, false);
    assert.equal(pr.user?.login, 'diplodoc-bot');
    assert.equal(pr.base?.ref, 'master');
    assert.equal(pr.head?.repo?.full_name, `${OWNER}/cli`);
    assert.equal(pr.head?.ref, `codex/dependency-candidate-${trainId}`);
    assert.equal(pr.head?.sha, sha, 'CLI candidate changed before closing');
    if (pr.state === 'closed') return;

    assert.equal(pr.state, 'open');
    const closed = await request(route, {method: 'PATCH', body: {state: 'closed'}});
    assert.equal(closed.state, 'closed', 'GitHub did not close the temporary CLI PR');
}

async function main(mode, env = process.env) {
    const summary = (text) => appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`);
    const request = (route, options) => github(route, {token: env.GH_TOKEN, ...options});
    assert.ok(env.GH_TOKEN, 'A scoped App token is required');

    if (mode === 'dispatch') {
        summary(
            `Source PRs were merged. [Open Update Submodules](${ACTIONS_URL}/workflows/${WORKFLOW}).`,
        );
        const id = await dispatchUpdate(request);
        appendFileSync(env.GITHUB_OUTPUT, `run-id=${id}\n`);
        summary(`[Update Submodules run #${id}](${ACTIONS_URL}/runs/${id}) was dispatched.`);
        return;
    }

    if (mode === 'wait') {
        const id = Number(env.SUBMODULES_RUN_ID);
        assert.ok(Number.isSafeInteger(id) && id > 0, 'Missing Update Submodules run ID');
        const url = `${ACTIONS_URL}/runs/${id}`;
        summary(`[Update Submodules run #${id}](${url})`);
        try {
            await waitForUpdate(id, request);
        } catch (error) {
            summary(
                `Source PRs are merged and the CLI candidate remains open. If [Update Submodules](${url}) failed, rerun its failed jobs there. After it succeeds, rerun this failed infra job to close the candidate.`,
            );
            throw error;
        }
        summary('Update Submodules succeeded. The temporary CLI PR can now be closed.');
        return;
    }

    assert.equal(mode, 'close');
    await closeCandidate(
        {number: Number(env.CANDIDATE_PR), sha: env.CANDIDATE_SHA, trainId: env.TRAIN_ID},
        request,
    );
}

if (require.main === module) {
    main(process.argv[2]).catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = {dispatchUpdate, waitForUpdate, closeCandidate};
