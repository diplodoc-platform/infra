'use strict';

const assert = require('node:assert/strict');
const {DEEP_PROFILES} = require('../dependency-verification-profiles');

const COMPARISON = 'Run Selected Deep Profile / Trusted comparison (never executes package code)';
const ACTIONS_APP = 15368;
const WORKFLOWS = [
    '.github/workflows/dependency-deep-verification.yml',
    '.github/workflows/dependency-risk-assessment.yml',
];
const TESTPACK = 'diplodoc-platform/testpack/.github/workflows/downstream-check.yml@master';

function needsDeepProfile(item) {
    return item.risk !== 'low' && DEEP_PROFILES.includes(item.profile);
}

function deepProfileRun(item, checks) {
    return checks.check_runs
        .filter(
            (run) =>
                run.name === COMPARISON && run.app?.id === ACTIONS_APP && run.head_sha === item.sha,
        )
        .sort((a, b) => b.id - a.id)[0];
}

async function requireDeepProfile(item, checks, request) {
    if (!needsDeepProfile(item)) return;

    const prefix = `/repos/diplodoc-platform/${item.repo}/actions/runs/`;
    const check = deepProfileRun(item, checks);
    const failure = `${item.repo}#${item.number}: required ${item.profile} comparison is not green on the exact head`;
    assert.ok(check?.status === 'completed' && check.conclusion === 'success', failure);
    const detailsPrefix = `https://github.com/diplodoc-platform/${item.repo}/actions/runs/`;
    assert.ok(check.details_url?.startsWith(detailsPrefix), failure);
    const match = /^(\d+)\/job\/\d+$/.exec(check.details_url.slice(detailsPrefix.length));
    assert.ok(match, failure);

    const [, id] = match;
    const run = await request(prefix + id);
    assert.ok(
        String(run.id) === id &&
            run.event === 'pull_request' &&
            run.head_sha === item.sha &&
            run.check_suite_id === check.check_suite?.id &&
            WORKFLOWS.includes(run.path) &&
            Number.isSafeInteger(run.run_attempt) &&
            run.run_attempt > 0 &&
            run.referenced_workflows?.some(
                (workflow) => workflow.path === TESTPACK && /^[a-f0-9]{40}$/.test(workflow.sha),
            ),
        failure,
    );

    const name = `dependency-comparison-${id}-${run.run_attempt}-${item.repo}-${item.sha}-${item.profile}`;
    const result = await request(`${prefix}${id}/artifacts?name=${encodeURIComponent(name)}`);
    assert.ok(
        result.artifacts?.some((artifact) => artifact.name === name && artifact.expired === false),
        failure,
    );
}

module.exports = {requireDeepProfile, needsDeepProfile, deepProfileRun};
