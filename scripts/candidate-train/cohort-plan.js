'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const yaml = require('js-yaml');
const {OWNER, SHA, fileAt, pages, planId, validatePlan, buildOrder} = require('./common');
const {parseCohort, PACKAGE} = require('./cohort');
const {repositoryTargets} = require('./waves');
const {deriveChecksGreen} = require('../auto-merge');

/** Select the entire explicit group or fail; this path is unavailable to schedules. */
async function planCohort(env, request, evidence, {graphAt, assess}) {
    assert.equal(
        env.GITHUB_EVENT_NAME,
        'workflow_dispatch',
        'Cohorts require an explicit manual dispatch',
    );
    assert.equal(
        Number(env.DEPENDENCY_TRAIN_PR_NUMBER || 0),
        0,
        'Do not combine cohort and single-PR selection',
    );
    assert.equal(
        Number(env.DEPENDENCY_TRAIN_WAVE || 1),
        1,
        'A cohort is indivisible, not a wave number',
    );
    const requests = parseCohort(env.DEPENDENCY_TRAIN_COHORT_PRS);
    const dependency = (env.DEPENDENCY_TRAIN_COHORT_DEPENDENCY || '').trim();
    if (dependency) assert.match(dependency, PACKAGE);
    assert.match(env.GITHUB_SHA, SHA);
    const metapackageSha = (await request(`/repos/${OWNER}/diplodoc/branches/master`)).commit.sha;
    const graph = await graphAt(metapackageSha, request);
    const cli = graph.find((node) => node.repo === 'cli');
    assert.ok(cli, 'Missing CLI in the metapackage');
    cli.sha = (await request(`/repos/${OWNER}/cli/branches/master`)).commit.sha;
    cli.manifest = JSON.parse(await fileAt('cli', cli.sha, 'package.json', request));
    repositoryTargets(
        graph,
        requests.map((item) => item.repo),
    );
    const registry = yaml.load(fs.readFileSync('dependency-policy.yml', 'utf8')).entries;
    const selected = [];
    const versions = new Set();
    for (const {repo, number} of requests) {
        const prefix = `/repos/${OWNER}/${repo}`;
        const pr = await request(`${prefix}/pulls/${number}`);
        assert.equal(pr.number, number);
        assert.equal(pr.base.repo.name, repo);
        assert.equal(
            pr.base.sha,
            (await request(`${prefix}/branches/master`)).commit.sha,
            `${repo}#${number}: refresh against current master`,
        );
        const [before, after, oldLock, newLock] = await Promise.all([
            fileAt(repo, pr.base.sha, 'package.json', request),
            fileAt(repo, pr.head.sha, 'package.json', request),
            fileAt(repo, pr.base.sha, 'package-lock.json', request),
            fileAt(repo, pr.head.sha, 'package-lock.json', request),
        ]).then((items) => items.map(JSON.parse));
        const assessment = assess(
            pr,
            await pages(`${prefix}/pulls/${number}/files`, request),
            before,
            after,
            oldLock,
            newLock,
            registry,
            {manual: true, dependency},
        );
        const node = graph.find((item) => item.repo === repo);
        assert.equal(
            node.manifest.version,
            after.version,
            'Update metapackage submodules before this cohort',
        );
        const checks = await evidence.fetchCheckRuns(env.GH_TOKEN, OWNER, repo, pr.head.sha);
        const required = await evidence.fetchRequiredChecks(env.GH_TOKEN, OWNER, repo, 'master');
        assert.ok(
            deriveChecksGreen(checks, required, pr.head.sha),
            `${repo}#${number}: required exact-head CI is not green`,
        );
        if (dependency) {
            const version = newLock.packages[`node_modules/${dependency}`]?.version;
            assert.ok(version, `${repo}: missing canonical cohort dependency`);
            versions.add(version);
        }
        Object.assign(node, {sha: pr.head.sha, manifest: after});
        selected.push({
            ...node,
            number,
            baseSha: pr.base.sha,
            risk: assessment.maxRisk,
            profile: assessment.verificationProfile,
        });
    }
    assert.ok(
        versions.size <= 1,
        'Cohort sources lock different versions of the shared dependency',
    );
    const cohort = {
        requests,
        ...(dependency ? {dependency: {name: dependency, version: [...versions][0]}} : {}),
    };
    const date = new Date(Date.now() + 3 * 60 * 60_000).toISOString().slice(0, 10);
    const plan = {
        schema: 2,
        toolSha: env.GITHUB_SHA,
        metapackageSha,
        cli: structuredClone(cli),
        graph,
        selected,
        cohort,
        readyBy: `${date}T05:00:00.000Z`,
    };
    plan.id = planId(plan);
    validatePlan(plan);
    buildOrder(graph, selected);
    return plan;
}

module.exports = {planCohort};
