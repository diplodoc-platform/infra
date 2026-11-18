'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const {
    dispatchUpdate,
    waitForUpdate,
    closeCandidate,
} = require('../../scripts/candidate-train/submodules');

const tests = [];
const test = (name, fn) => tests.push({name, fn});
const runId = 123456789;
const runRoute = `/repos/diplodoc-platform/diplodoc/actions/runs/${runId}`;
const run = {
    id: runId,
    path: '.github/workflows/update-submodules.yml',
    event: 'workflow_dispatch',
    head_branch: 'master',
    status: 'completed',
    conclusion: 'success',
};

test('dispatch returns the exact Update Submodules run ID on metapackage master', async () => {
    const id = await dispatchUpdate(async (route, options) => {
        assert.equal(
            route,
            '/repos/diplodoc-platform/diplodoc/actions/workflows/update-submodules.yml/dispatches',
        );
        assert.equal(options.method, 'POST');
        assert.equal(options.apiVersion, '2026-03-10');
        assert.deepEqual(options.body, {ref: 'master'});
        return {workflow_run_id: runId};
    });
    assert.equal(id, runId);
    await assert.rejects(
        dispatchUpdate(async () => null),
        /did not return.*run ID/,
    );
});

test('wait follows the same run until success and rejects unsuccessful or unrelated runs', async () => {
    const states = ['queued', 'in_progress', 'completed'];
    await waitForUpdate(
        runId,
        async (route) => {
            assert.equal(route, runRoute);
            return {...run, status: states.shift()};
        },
        {delay: async () => {}},
    );
    assert.equal(states.length, 0);

    await assert.rejects(
        waitForUpdate(runId, async () => ({...run, conclusion: 'failure'})),
        /finished with failure/,
    );
    await assert.rejects(waitForUpdate(runId, async () => ({...run, event: 'schedule'})));

    let time = 0;
    await assert.rejects(
        waitForUpdate(runId, async () => ({...run, status: 'queued'}), {
            now: () => time,
            delay: async (ms) => {
                time += ms;
            },
        }),
        /Timed out/,
    );
});

test('cleanup closes only the expected candidate and can safely retry an already closed PR', async () => {
    const candidate = {number: 42, sha: 'a'.repeat(40), trainId: 'b'.repeat(16)};
    const pr = {
        merged: false,
        user: {login: 'diplodoc-bot'},
        base: {ref: 'master'},
        head: {
            repo: {full_name: 'diplodoc-platform/cli'},
            ref: `codex/dependency-candidate-${candidate.trainId}`,
            sha: candidate.sha,
        },
        state: 'open',
    };
    const writes = [];
    const request = async (route, options) => {
        assert.equal(route, '/repos/diplodoc-platform/cli/pulls/42');
        if (options) {
            writes.push(options);
            pr.state = 'closed';
        }
        return pr;
    };
    await assert.rejects(
        closeCandidate({...candidate, sha: 'c'.repeat(40)}, request),
        /candidate changed/,
    );
    assert.deepEqual(writes, []);
    await closeCandidate(candidate, request);
    await closeCandidate(candidate, request);
    assert.deepEqual(writes, [{method: 'PATCH', body: {state: 'closed'}}]);
});

test('workflow dispatches only after live merge and retries cleanup against the same run', () => {
    const {jobs} = yaml.load(
        fs.readFileSync(
            path.join(__dirname, '../../.github/workflows/merge-verified-train.yml'),
            'utf8',
        ),
    );
    assert.equal(jobs['dispatch-submodules'].needs, 'merge');
    assert.ok(jobs.finish.needs.includes('dispatch-submodules'));
    const steps = jobs.finish.steps;
    const wait = steps.find((step) => step.run?.endsWith('submodules.js wait'));
    const close = steps.find((step) => step.run?.endsWith('submodules.js close'));
    assert.equal(wait.env.SUBMODULES_RUN_ID, '${{ needs.dispatch-submodules.outputs.run-id }}');
    assert.equal(close.env.CANDIDATE_SHA, '${{ needs.merge.outputs.candidate-sha }}');
    assert.ok(steps.indexOf(wait) < steps.indexOf(close));
    assert.equal(wait['continue-on-error'], undefined);
    assert.equal(close.if, undefined);
});

module.exports = {tests};
