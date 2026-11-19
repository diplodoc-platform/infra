#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const {sourceHeadRepo} = require('./prepare-policy');
const fs = require('node:fs');
const {isDeepStrictEqual} = require('node:util');
const {OWNER, SHA, github, buildOrder, write} = require('./common');
const {fetchCheckRuns, fetchRequiredChecks, deriveChecksGreen} = require('../auto-merge');
const {groupRisk} = require('./risk');
const {requireDeepProfile} = require('./deep-profile');
const {verifiedVerdict} = require('./verdict');
const {authorizeControl, requireOperatorWrite} = require('./control-authorization');
const {packageRegistrationsAt} = require('./metapackage');
const {selectMergeMethod, rebaseTrees, verifyRebase} = require('./merge-method');

/** Read data as Git blobs, never following a symlink or executing the candidate. */
async function candidateFile(sha, name, request) {
    const prefix = `/repos/${OWNER}/cli`;
    const root = await request(`${prefix}/git/trees/${sha}`);
    assert.equal(root.truncated, false);
    const directory = root.tree.find((entry) => entry.path === 'dependency-train');
    assert.ok(
        directory?.type === 'tree' && directory.mode === '040000',
        'Missing candidate data directory',
    );
    const tree = await request(`${prefix}/git/trees/${directory.sha}`);
    assert.equal(tree.truncated, false);
    const entry = tree.tree.find((item) => item.path === name);
    assert.ok(
        entry?.type === 'blob' && entry.mode === '100644',
        'Candidate metadata must be a regular blob',
    );
    const blob = await request(`${prefix}/git/blobs/${entry.sha}`);
    assert.ok(blob.encoding === 'base64' && blob.size > 0 && blob.size < 8 * 1024 * 1024);
    return Buffer.from(blob.content.replace(/\s/g, ''), 'base64').toString('utf8');
}

async function readVerifiedCandidate(number, request, token, readChecks = fetchCheckRuns) {
    assert.ok(Number.isSafeInteger(number) && number > 0);
    const pr = await request(`/repos/${OWNER}/cli/pulls/${number}`);
    assert.equal(pr.user?.login, 'diplodoc-bot');
    assert.equal(pr.merged, false, 'Never merge a temporary CLI candidate');
    assert.equal(pr.head.repo?.full_name, `${OWNER}/cli`);
    assert.equal(pr.base.repo?.full_name, `${OWNER}/cli`);
    assert.equal(pr.base.ref, 'master');
    assert.match(pr.head.sha, SHA);
    const candidate = {owner: OWNER, repo: 'cli', number, sha: pr.head.sha};
    const [planBytes, proofBytes, checks] = await Promise.all([
        candidateFile(candidate.sha, 'plan.json', request),
        candidateFile(candidate.sha, 'proof.json', request),
        readChecks(token, OWNER, 'cli', candidate.sha),
    ]);
    const verified = verifiedVerdict(checks.check_runs, candidate, planBytes, proofBytes);
    assert.ok(
        verified.plan.schema === 2 && verified.plan.cohort?.dependency,
        'The merge entrypoint requires a complete coordinated dependency group',
    );
    assert.equal(pr.head.ref, `codex/dependency-candidate-${verified.plan.id}`);
    const commit = await request(`/repos/${OWNER}/cli/git/commits/${candidate.sha}`);
    assert.deepEqual(
        commit.parents.map((parent) => parent.sha),
        [verified.plan.cli.sha],
    );
    return {...verified, candidate};
}

async function baselineUnchanged(plan, request, registrationsBySha = new Map()) {
    const cli = await request(`/repos/${OWNER}/cli/branches/master`);
    assert.equal(cli.commit.sha, plan.cli.sha, 'cli baseline changed; rebuild the train');

    const meta = await request(`/repos/${OWNER}/diplodoc/branches/master`);
    if (meta.commit.sha !== plan.metapackageSha) {
        const registrationsAt = (sha) => {
            if (!registrationsBySha.has(sha)) {
                registrationsBySha.set(sha, packageRegistrationsAt(sha, request));
            }
            return registrationsBySha.get(sha);
        };
        const [frozen, current] = await Promise.all([
            registrationsAt(plan.metapackageSha),
            registrationsAt(meta.commit.sha),
        ]);
        const changedPath = [...new Set([...frozen.keys(), ...current.keys()])].find(
            (directory) => !isDeepStrictEqual(frozen.get(directory), current.get(directory)),
        );
        assert.ok(
            !changedPath,
            `diplodoc package input changed (${changedPath}); rebuild the train`,
        );
    }
    for (const {repo, sha} of plan.cohort?.baseline || []) {
        assert.equal(
            (await request(`/repos/${OWNER}/${repo}/branches/master`)).commit.sha,
            sha,
            `${repo}: unchanged group consumer advanced; rebuild the train`,
        );
    }
}

async function sourceReady(item, request, token, evidence, operator) {
    assert.ok(!['cli', 'vsc', 'infra'].includes(item.repo), 'Unsupported merge target');
    if (operator) await requireOperatorWrite(item.repo, operator, request);
    const prefix = `/repos/${OWNER}/${item.repo}`;
    const pr = await request(`${prefix}/pulls/${item.number}`);
    assert.equal(pr.head.repo?.full_name, sourceHeadRepo(pr, item.repo));
    assert.equal(pr.base.repo?.full_name, `${OWNER}/${item.repo}`);
    assert.equal(pr.base.ref, 'master');
    assert.equal(pr.head.sha, item.sha, `${item.repo}: source head changed`);
    if (pr.merged === true) {
        const commit = await request(`${prefix}/git/commits/${pr.merge_commit_sha}`);
        if (commit.parents[0]?.sha !== item.baseSha) {
            await verifyRebase(item, commit, await rebaseTrees(item, pr.commits, request), request);
        }
        assert.equal(
            (await request(`${prefix}/branches/master`)).commit.sha,
            pr.merge_commit_sha,
            `${item.repo}: previously merged source advanced; rebuild the train`,
        );
        return {
            repo: item.repo,
            number: item.number,
            sha: item.sha,
            merged: true,
            commit: pr.merge_commit_sha,
        };
    }
    assert.equal(pr.state, 'open');
    assert.equal(pr.draft, false);
    assert.equal(pr.base.sha, item.baseSha, `${item.repo}: source base changed`);
    assert.equal((await request(`${prefix}/branches/master`)).commit.sha, item.baseSha);
    const checks = await evidence.fetchCheckRuns(token, OWNER, item.repo, item.sha);
    const required = await evidence.fetchRequiredChecks(token, OWNER, item.repo, 'master');
    assert.ok(
        deriveChecksGreen(checks, required, item.sha),
        `${item.repo}: required exact-head CI is not green`,
    );
    await requireDeepProfile(item, checks, request);
    const review = await request('/graphql', {
        method: 'POST',
        body: {
            query: 'query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){squashMergeAllowed rebaseMergeAllowed pullRequest(number:$number){headRefOid baseRefOid reviewDecision mergeStateStatus}}}',
            variables: {owner: OWNER, repo: item.repo, number: item.number},
        },
    });
    assert.ok(!review.errors?.length, 'Review state is unavailable');
    const repository = review.data?.repository;
    const state = repository?.pullRequest;
    assert.equal(state?.headRefOid, item.sha);
    assert.equal(state?.baseRefOid, item.baseSha);
    assert.ok(
        state.reviewDecision === 'APPROVED' || state.reviewDecision === null,
        `${item.repo}: required review is missing`,
    );
    assert.equal(state.mergeStateStatus, 'CLEAN', `${item.repo}: GitHub merge gate is not green`);
    const mergeMethod = await selectMergeMethod(item.repo, repository, request);
    const source = {
        repo: item.repo,
        number: item.number,
        sha: item.sha,
        merged: false,
        mergeMethod,
    };
    if (mergeMethod === 'squash') return source;

    // GitHub may return null while calculating rebaseability. The linear
    // history check below proves the PR already starts at the exact target base.
    assert.notEqual(
        pr.rebaseable,
        false,
        `${item.repo}: GitHub reports that this PR cannot be rebased`,
    );
    const trees = await rebaseTrees(item, pr.commits, request);
    return {...source, trees};
}

/** A user dispatch is the only merge entrypoint. A rerun rechecks actual merged PRs, never trusts a journal. */
async function mergeTrain(
    env = process.env,
    request = (route, options) =>
        github(route, {
            token:
                (options?.method || 'GET') === 'GET' || route === '/graphql'
                    ? env.GH_READ_TOKEN || env.GH_TOKEN
                    : env.GH_TOKEN,
            ...options,
        }),
    evidence = {fetchCheckRuns, fetchRequiredChecks},
    save = () => {},
) {
    assert.equal(
        env.GITHUB_EVENT_NAME,
        'workflow_dispatch',
        'Merging requires an explicit user dispatch',
    );
    const live = env.DEPENDENCY_TRAIN_MERGE_APPROVED === 'true';
    const evidenceToken = env.GH_READ_TOKEN || env.GH_TOKEN;
    const verified = await readVerifiedCandidate(
        Number(env.CANDIDATE_PR),
        request,
        evidenceToken,
        evidence.fetchCheckRuns,
    );
    const {plan, candidate} = verified;
    const operator = await authorizeControl(env, verified, request);
    if (live) {
        assert.equal(env.CONFIRM_TRAIN_ID, plan.id, 'Confirm the exact verified train ID');
        assert.equal(
            groupRisk(plan.selected),
            'low',
            'Candidates above low risk require merging the source PRs through their review process',
        );
    }
    const report = {
        schema: 1,
        trainId: plan.id,
        candidate,
        checkId: verified.checkId,
        operator,
        ...(env.REQUEST_CHECK_ID ? {requestCheckId: Number(env.REQUEST_CHECK_ID)} : {}),
        dryRun: !live,
        sources: [],
        complete: false,
    };
    save(report);
    const registrationsBySha = new Map();
    try {
        await baselineUnchanged(plan, request, registrationsBySha);
        const ordered = buildOrder(plan.graph, plan.selected)
            .map((node) => plan.selected.find((item) => item.repo === node.repo))
            .filter(Boolean);
        // Preflight the entire indivisible group before the first write.
        for (const item of ordered) {
            const {trees: _trees, ...source} = await sourceReady(
                item,
                request,
                evidenceToken,
                evidence,
                operator,
            );
            report.sources.push(source);
        }
        save(report);
        if (!live) return report;
        for (const item of ordered) {
            const row = report.sources.find((source) => source.repo === item.repo);
            if (row.merged) continue;
            await baselineUnchanged(plan, request, registrationsBySha);
            const current = await readVerifiedCandidate(
                candidate.number,
                request,
                evidenceToken,
                evidence.fetchCheckRuns,
            );
            await authorizeControl(env, current, request);
            assert.deepEqual(current.candidate, candidate, 'Candidate changed during the merge');
            assert.deepEqual(
                current.verdict,
                verified.verdict,
                'Verification changed during the merge',
            );
            let target;
            for (const source of ordered) {
                const ready = await sourceReady(source, request, evidenceToken, evidence, operator);
                if (source.repo === item.repo) target = ready;
            }
            assert.ok(
                target && !target.merged,
                `${item.repo}: source was merged concurrently; repeat preview`,
            );

            // Recheck the target base after the group reads. GitHub only pins the PR head.
            const prefix = `/repos/${OWNER}/${item.repo}`;
            const base = await request(`${prefix}/branches/master`);
            assert.equal(base.commit.sha, item.baseSha, `${item.repo}: source base changed`);

            const result = await request(`${prefix}/pulls/${item.number}/merge`, {
                method: 'PUT',
                body: {sha: item.sha, merge_method: target.mergeMethod},
            });
            assert.equal(result.merged, true, `${item.repo}: merge was refused`);
            Object.assign(row, {merged: true, commit: result.sha, mergeMethod: target.mergeMethod});
            save(report);
            const merged = await request(`${prefix}/git/commits/${result.sha}`);
            if (target.mergeMethod === 'rebase') {
                await verifyRebase(item, merged, target.trees, request);
            } else {
                assert.equal(
                    merged.parents[0]?.sha,
                    item.baseSha,
                    `${item.repo}: merged baseline differs from the verified baseline`,
                );
            }
        }
        report.complete = true;
        save(report);
        return report;
    } catch (error) {
        report.error = error.message;
        save(report);
        throw error;
    }
}

/** The first reader token is CLI-only; the canonical App verdict supplies the precise scope. */
async function inventory(env = process.env) {
    assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
    const verified = await readVerifiedCandidate(
        Number(env.CANDIDATE_PR),
        (route, options) => github(route, {token: env.GH_TOKEN, ...options}),
        env.GH_TOKEN,
    );
    const repositories = [
        ...new Set([...verified.plan.selected.map((source) => source.repo), 'cli']),
    ];
    const readers = [...new Set([...repositories, 'infra', 'diplodoc'])];
    fs.appendFileSync(
        env.GITHUB_OUTPUT,
        `repositories=${repositories.join(',')}\nread-repositories=${readers.join(',')}\n`,
    );
}

if (require.main === module && process.argv[2] === 'inventory') {
    inventory().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
} else if (require.main === module) {
    mergeTrain(process.env, undefined, undefined, (report) => write('merge-progress.json', report))
        .then((report) => {
            if (process.env.GITHUB_OUTPUT)
                fs.appendFileSync(
                    process.env.GITHUB_OUTPUT,
                    `repositories=${[...new Set([...report.sources.map((item) => item.repo), 'cli'])].join(',')}\ntrain-id=${report.trainId}\ncandidate-sha=${report.candidate.sha}\n`,
                );
            if (process.env.GITHUB_STEP_SUMMARY)
                fs.appendFileSync(
                    process.env.GITHUB_STEP_SUMMARY,
                    `Verified train ${report.trainId}: ${report.sources.filter((item) => item.merged).length}/${report.sources.length} merged. ${report.dryRun ? 'Preview only.' : 'Operator-requested merge.'}\n`,
                );
        })
        .catch((error) => {
            console.error(error.message);
            process.exitCode = 1;
        });
}

module.exports = {candidateFile, readVerifiedCandidate, baselineUnchanged, sourceReady, mergeTrain};
