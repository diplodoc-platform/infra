'use strict';

const assert = require('node:assert/strict');
const {appendFileSync} = require('node:fs');
const {setTimeout: delay} = require('node:timers/promises');
const {OWNER, SHA} = require('./common');
const {PACKAGE, parseCohort} = require('./cohort');
const {assertRiskProfile} = require('./risk');
const {needsDeepProfile, deepProfileRun, requireDeepProfile} = require('./deep-profile');
const {fetchCheckRuns, fetchRequiredChecks, latestRequiredRun} = require('../auto-merge');

const WAIT_MS = 40 * 60_000;
const POLL_MS = 60_000;

function writeRefreshReceipt(plan, sources, env) {
    if (!sources?.length || env.DEPENDENCY_TRAIN_INLINE_REFRESH !== 'true') return;
    const receipt = {
        toolSha: plan.toolSha,
        dependency: plan.group.dependency,
        baseline: plan.group.baseline || [],
        sources: sources
            .map(({repo, number, sha, baseSha, risk, profile}) => ({
                repo,
                number,
                sha,
                baseSha,
                risk,
                profile,
            }))
            .sort((a, b) => a.repo.localeCompare(b.repo)),
    };
    appendFileSync(env.GITHUB_OUTPUT, `receipt=${JSON.stringify(receipt)}\n`);
}

function readRefreshReceipt(env) {
    if (!env.DEPENDENCY_TRAIN_REFRESH_RECEIPT) return null;
    assert.equal(env.GITHUB_REPOSITORY, `${OWNER}/infra`);
    assert.equal(env.GITHUB_REF, 'refs/heads/master');
    assert.equal(env.DEPENDENCY_TRAIN_SELECTION_MODE, 'cohort');
    assert.ok(!env.DEPENDENCY_TRAIN_COHORT_PRS?.trim());
    assert.ok(!env.DEPENDENCY_TRAIN_COHORT_DEPENDENCY?.trim());
    assert.equal(Number(env.DEPENDENCY_TRAIN_PR_NUMBER || 0), 0);
    assert.equal(Number(env.DEPENDENCY_TRAIN_WAVE || 1), 1);
    const receipt = JSON.parse(env.DEPENDENCY_TRAIN_REFRESH_RECEIPT);
    assert.match(receipt.toolSha, SHA);
    assert.equal(receipt.toolSha, env.GITHUB_SHA);
    assert.match(receipt.dependency.name, PACKAGE);
    assert.match(receipt.dependency.version, /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/);
    const requests = receipt.sources.map(({repo, number}) => ({repo, number}));
    assert.deepEqual(
        requests,
        parseCohort(requests.map(({repo, number}) => `${repo}#${number}`).join(',')),
    );
    for (const item of receipt.sources) {
        assert.match(item.sha, SHA);
        assert.match(item.baseSha, SHA);
        assertRiskProfile(item.risk, item.profile);
    }
    assert.ok(Array.isArray(receipt.baseline));
    return {...receipt, requests};
}

function pendingCheck(run, name, source) {
    if (run?.status !== 'completed') return `${source}: ${name} (${run?.status || 'waiting'})`;
    assert.equal(run.conclusion, 'success', `${source}: ${name} ended with ${run.conclusion}`);
    return null;
}

async function sourceChecks(item, request, token, evidence) {
    const {repo, number, sha, baseSha} = item;
    const source = `${repo}#${number} @ ${sha}`;
    const prefix = `/repos/${OWNER}/${repo}`;
    const [pr, master, required] = await Promise.all([
        request(`${prefix}/pulls/${number}`),
        request(`${prefix}/branches/master`),
        evidence.fetchRequiredChecks(token, OWNER, repo, 'master'),
    ]);
    assert.ok(
        pr.number === number && pr.state === 'open' && pr.draft === false,
        `${source}: PR is no longer open for CI`,
    );
    assert.equal(pr.head.repo?.full_name, `${OWNER}/${repo}`);
    assert.equal(pr.base.repo?.full_name, `${OWNER}/${repo}`);
    assert.equal(pr.base.ref, 'master');
    assert.equal(pr.head.sha, sha, `${source}: source head changed while waiting for CI`);
    assert.equal(pr.base.sha, baseSha, `${source}: source base changed while waiting for CI`);
    assert.equal(master.commit.sha, baseSha, `${source}: master changed while waiting for CI`);
    assert.ok(required.length, `${source}: required checks are unavailable`);
    return {item, source, required};
}

async function pendingSourceChecks({item, source, required}, request, token, evidence) {
    const {repo, sha} = item;
    const checks = await evidence.fetchCheckRuns(token, OWNER, repo, sha);
    const pending = required
        .map((check) =>
            pendingCheck(
                latestRequiredRun(checks.check_runs, check, sha, {allowUnboundPublisher: true}),
                check.context,
                source,
            ),
        )
        .filter(Boolean);
    if (needsDeepProfile(item)) {
        const deep = pendingCheck(deepProfileRun(item, checks), item.profile, source);
        if (deep) pending.push(deep);
        else await requireDeepProfile(item, checks, request);
    }
    return pending;
}

async function waitForRefreshedGroup(
    receipt,
    request,
    token,
    {
        evidence = {fetchCheckRuns, fetchRequiredChecks},
        sleep = delay,
        now = Date.now,
        report = console.log,
        timeout = WAIT_MS,
    } = {},
) {
    const deadline = now() + timeout;
    let sources = await Promise.all(
        receipt.sources.map((item) => sourceChecks(item, request, token, evidence)),
    );
    let previous = '';
    while (sources.length) {
        const statuses = await Promise.all(
            sources.map((source) => pendingSourceChecks(source, request, token, evidence)),
        );
        sources = sources.filter((_, index) => statuses[index].length);
        if (!sources.length) return;

        const message = statuses.flat().join('\n');
        const remaining = deadline - now();
        assert.ok(remaining > 0, `Timed out waiting for refreshed source CI:\n${message}`);
        if (message !== previous) report(message);
        previous = message;
        await sleep(Math.min(POLL_MS, remaining));
    }
}

module.exports = {writeRefreshReceipt, readRefreshReceipt, waitForRefreshedGroup};
