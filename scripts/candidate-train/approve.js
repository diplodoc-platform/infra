'use strict';

const assert = require('node:assert/strict');
const {appendFileSync} = require('node:fs');
const {OWNER, SHA, github, pages, fileAt} = require('./common');
const {approvalRepositories} = require('./approval-scope');
const {baselineUnchanged, readVerifiedCandidate, verifyOpenSource} = require('./merge');
const {APP_RECONCILE_AUTHOR, reconciliationSeed} = require('./reconcile-lock');
const {readReconciledInput} = require('./reconcile-source');
const {fetchCheckRuns, fetchRequiredChecks} = require('../auto-merge');
const {groupRisk, riskWeight} = require('./risk');

const BOT = 'diplodoc-bot';
const CLI = `/repos/${OWNER}/cli`;

async function verifiedApproval(env, request, evidence) {
    const number = Number(env.CANDIDATE_PR);
    const checkId = Number(env.VERIFIER_CHECK_ID);
    assert.ok(Number.isSafeInteger(number) && number > 0);
    assert.ok(Number.isSafeInteger(checkId) && checkId > 0);
    assert.match(env.CANDIDATE_SHA, SHA);

    const pr = await request(`${CLI}/pulls/${number}`);
    assert.equal(pr.state, 'open', 'The CLI candidate is closed');
    assert.equal(pr.head.sha, env.CANDIDATE_SHA);
    const verified = await readVerifiedCandidate(
        number,
        request,
        env.GH_TOKEN,
        evidence.fetchCheckRuns,
    );
    assert.equal(verified.candidate.sha, env.CANDIDATE_SHA);
    assert.equal(verified.checkId, checkId, 'Internal Check was superseded');

    const scope = env.DEPENDENCY_TRAIN_BOT_APPROVAL_REPOSITORIES;
    assert.ok(scope?.trim(), 'Configure a pilot repository list or all');
    const allowed = approvalRepositories(scope, verified.plan.graph);
    assert.ok(
        verified.plan.selected.every(({repo}) => allowed.has(repo)),
        'The verified group is outside the bot approval pilot',
    );
    assert.ok(
        riskWeight(groupRisk(verified.plan.selected)) <=
            riskWeight(env.DEPENDENCY_TRAIN_MAX_RISK || 'low'),
        'The verified group exceeds the current risk ceiling',
    );

    return verified.plan;
}

async function verifyReconciliation(pr, item, plan, request) {
    const readSource = (repo, sha, file) => fileAt(repo, sha, file, request);
    const [before, after, oldLock, revisedLock, cliLock] = await Promise.all([
        readSource(item.repo, item.baseSha, 'package.json').then(JSON.parse),
        readSource(item.repo, item.sha, 'package.json').then(JSON.parse),
        readSource(item.repo, item.baseSha, 'package-lock.json').then(JSON.parse),
        readSource(item.repo, item.sha, 'package-lock.json').then(JSON.parse),
        readSource('cli', plan.cli.sha, 'package-lock.json').then(JSON.parse),
    ]);
    const {input} = await readReconciledInput(
        pr,
        before,
        after,
        oldLock,
        revisedLock,
        plan.cli,
        cliLock,
        readSource,
        request,
    );
    assert.deepEqual(input, plan.cohort.dependency, 'Reconciliation target changed');
}

async function reviewTarget(item, plan, request, token, evidence) {
    const route = `/repos/${OWNER}/${item.repo}/pulls/${item.number}`;
    const pr = await request(route);
    const reconcile = pr.user?.login === APP_RECONCILE_AUTHOR && reconciliationSeed(pr);
    assert.ok(
        reconcile ||
            (pr.user?.login === 'dependabot[bot]' && pr.head.ref.startsWith('dependabot/')),
        'The pilot only approves native Dependabot PRs or trusted App reconciliation PRs',
    );
    assert.equal(pr.head.repo?.full_name, `${OWNER}/${item.repo}`);
    assert.equal(pr.base.repo?.full_name, `${OWNER}/${item.repo}`);
    assert.equal(pr.base.ref, 'master');
    assert.equal(pr.head.sha, item.sha);
    await verifyOpenSource(item, pr, request, token, evidence);

    const files = await pages(`${route}/files`, request);
    assert.ok(
        files.length > 0 &&
            files.every(
                ({filename, status}) =>
                    ['package.json', 'package-lock.json'].includes(filename) &&
                    status === 'modified',
            ),
        'Only dependency manifests and lockfiles may be approved',
    );

    if (reconcile) await verifyReconciliation(pr, item, plan, request);

    const result = await request('/graphql', {
        method: 'POST',
        body: {
            query: 'query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){headRefOid baseRefOid reviewDecision}}}',
            variables: {owner: OWNER, repo: item.repo, number: item.number},
        },
    });
    assert.ok(!result.errors?.length, 'Review state is unavailable');
    const state = result.data?.repository?.pullRequest;
    assert.equal(state?.headRefOid, item.sha);
    assert.equal(state.baseRefOid, item.baseSha);
    assert.ok(
        ['REVIEW_REQUIRED', 'APPROVED', null].includes(state.reviewDecision),
        'A reviewer requested changes or review state is unavailable',
    );

    const reviews = await pages(`${route}/reviews`, request);
    const previous = reviews
        .filter(
            ({user, state: reviewState}) =>
                user?.login === BOT &&
                ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(reviewState),
        )
        .at(-1);

    return {
        route,
        alreadyApproved: previous?.state === 'APPROVED' && previous.commit_id === item.sha,
    };
}

async function approveVerified(
    env,
    request,
    botRequest,
    evidence = {fetchCheckRuns, fetchRequiredChecks},
) {
    assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
    assert.equal(env.GITHUB_REPOSITORY, `${OWNER}/infra`);
    assert.equal(env.GITHUB_REF, 'refs/heads/master');
    assert.equal(env.GITHUB_ACTOR, 'diplodoc-app[bot]');
    const plan = await verifiedApproval(env, request, evidence);

    if (!botRequest)
        return [...new Set(['cli', 'diplodoc', ...plan.selected.map(({repo}) => repo)])];

    assert.equal((await botRequest('/user')).login, BOT);
    await baselineUnchanged(plan, request);
    // Check every source before writing the first review.
    for (const item of plan.selected)
        await reviewTarget(item, plan, request, env.GH_TOKEN, evidence);
    const results = [];
    for (const item of plan.selected) {
        await verifiedApproval(env, request, evidence);
        await baselineUnchanged(plan, request);
        const {route, alreadyApproved} = await reviewTarget(
            item,
            plan,
            request,
            env.GH_TOKEN,
            evidence,
        );
        if (!alreadyApproved) {
            const review = await botRequest(`${route}/reviews`, {
                method: 'POST',
                body: {
                    event: 'APPROVE',
                    commit_id: item.sha,
                    body: `Automated dependency review for verified CLI #${env.CANDIDATE_PR}, Internal Check #${env.VERIFIER_CHECK_ID}.`,
                },
            });
            assert.equal(review.commit_id, item.sha);
            assert.equal(review.state, 'APPROVED');
            assert.equal(review.user?.login, BOT);
        }
        results.push({repo: item.repo, number: item.number, sha: item.sha, alreadyApproved});
    }
    return results;
}

async function main(mode, env) {
    assert.ok(['inventory', 'apply'].includes(mode));
    if (mode === 'apply') assert.ok(env.TRAIN_APPROVER_TOKEN, 'Approver credential is required');
    const request = (route, options) => github(route, {token: env.GH_TOKEN, ...options});
    const botRequest =
        mode === 'apply'
            ? (route, options) => github(route, {token: env.TRAIN_APPROVER_TOKEN, ...options})
            : undefined;
    const result = await approveVerified(env, request, botRequest);
    if (botRequest) {
        appendFileSync(
            env.GITHUB_STEP_SUMMARY,
            result
                .map(
                    ({repo, number, sha, alreadyApproved}) =>
                        `- ${repo}#${number} @ \`${sha}\`: ${alreadyApproved ? 'already approved' : 'approved'}\n`,
                )
                .join(''),
        );
    } else {
        appendFileSync(env.GITHUB_OUTPUT, `repositories=${result.join(',')}\n`);
    }
}

if (require.main === module) {
    main(process.argv[2], process.env).catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = {approveVerified, reviewTarget};
