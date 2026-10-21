'use strict';

const assert = require('node:assert/strict');
const {isDeepStrictEqual} = require('node:util');
const fs = require('node:fs');
const yaml = require('js-yaml');
const {
    diffDirectDependencies,
    diffTransitiveDependencies,
    buildAssessment,
    classifyVersionChange,
} = require('../dependency-policy-review');
const {filterEntriesForRepo} = require('../generate-dependency-policy');
const {fetchRequiredChecks, fetchCheckRuns, deriveChecksGreen} = require('../auto-merge');
const {
    OWNER,
    SHA,
    REPO,
    SECTIONS,
    planId,
    github,
    pages,
    fileAt,
    buildOrder,
    write,
    validatePlan,
} = require('./common');

function allowlist(value) {
    const repos = (value || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    assert.ok(
        repos.length > 0 && repos.length <= 3,
        'Explicit allowlist of 1–3 repositories required',
    );
    assert.equal(new Set(repos).size, repos.length);
    repos.forEach((repo) => assert.match(repo, REPO));
    assert.ok(
        !repos.includes('cli'),
        'Direct CLI dependency updates need a separate candidate path',
    );
    return repos;
}

function assess(pr, files, before, after, oldLock, newLock, registry) {
    assert.equal(pr.user?.login, 'dependabot[bot]');
    assert.equal(pr.state, 'open');
    assert.equal(pr.draft, false);
    assert.equal(pr.base.ref, 'master');
    assert.equal(pr.head.repo?.full_name, `${OWNER}/${pr.base.repo.name}`);
    assert.match(pr.head.sha, SHA);
    assert.ok(
        files.length > 0 &&
            files.every(
                (item) =>
                    ['package.json', 'package-lock.json'].includes(item.filename) &&
                    !['removed', 'renamed'].includes(item.status),
            ),
        'Only dependency manifests/locks are supported',
    );
    const strip = (manifest) =>
        Object.fromEntries(Object.entries(manifest).filter(([key]) => !SECTIONS.includes(key)));
    assert.ok(isDeepStrictEqual(strip(before), strip(after)), 'Non-dependency manifest changes');
    assert.equal(oldLock.lockfileVersion, 3);
    assert.equal(newLock.lockfileVersion, 3);
    for (const [key, entry] of Object.entries(newLock.packages)) {
        if (key === '') continue;
        assert.ok(
            !entry.link && !entry.resolved?.startsWith('file:'),
            'Local source dependencies are not supported',
        );
    }
    for (const section of SECTIONS) {
        assert.ok(
            isDeepStrictEqual(newLock.packages[''][section] || {}, after[section] || {}),
            'Stale lock root',
        );
    }
    const direct = diffDirectDependencies(before, after);
    // Include locked direct versions too: unchanged manifest ranges can still
    // resolve to a new parser/sanitizer in a lock-only Dependabot update.
    const transitive = diffTransitiveDependencies(oldLock, newLock, []);
    const assessment = buildAssessment(
        direct,
        transitive,
        filterEntriesForRepo(registry, pr.base.repo.name),
    );
    const changes = [...assessment.direct, ...assessment.transitive];
    assert.ok(changes.length > 0, 'No dependency changes');
    assert.notEqual(assessment.maxRisk, 'critical', 'Critical update needs an individual pilot');
    assert.ok(
        !changes.some(
            (item) =>
                item.ignored ||
                item.change.changeType !== 'changed' ||
                !['patch', 'minor'].includes(
                    classifyVersionChange(item.change.from, item.change.to),
                ),
        ),
        'Major/new/removed/ignored updates need an individual pilot',
    );
    return assessment;
}

async function graphAt(sha, request = github) {
    const tree = await request(`/repos/${OWNER}/diplodoc/git/trees/${sha}?recursive=1`);
    assert.equal(tree.truncated, false);
    const modules = await fileAt('diplodoc', sha, '.gitmodules', request);
    const graph = [];
    for (const block of modules.split(/(?=\[submodule )/)) {
        const directory = /^\s*path\s*=\s*((?:packages|extensions)\/[a-z0-9-]+)\s*$/m.exec(
            block,
        )?.[1];
        const repo = /github\.com[:/]diplodoc-platform\/([a-z0-9-]+?)(?:\.git)?\s*$/m.exec(
            block,
        )?.[1];
        if (!directory || !repo) continue;
        const commit = tree.tree.find((item) => item.path === directory && item.type === 'commit');
        assert.ok(commit, `Missing registered submodule ${directory}`);
        graph.push({
            repo,
            sha: commit.sha,
            manifest: JSON.parse(await fileAt(repo, commit.sha, 'package.json', request)),
        });
    }
    assert.ok(graph.length > 0);
    return graph;
}

async function planTrain(
    env = process.env,
    request = (route) => github(route, {token: env.GH_TOKEN}),
) {
    const repos = allowlist(env.DEPENDENCY_TRAIN_REPOSITORIES);
    const prNumber = Number(env.DEPENDENCY_TRAIN_PR_NUMBER || 0);
    assert.ok(Number.isSafeInteger(prNumber) && prNumber >= 0, 'Invalid source PR number');
    assert.ok(prNumber === 0 || repos.length === 1, 'An exact PR requires one repository');
    assert.match(env.GITHUB_SHA, SHA);
    const metapackageSha = (await request(`/repos/${OWNER}/diplodoc/branches/master`)).commit.sha;
    const graph = await graphAt(metapackageSha, request);
    const cli = graph.find((item) => item.repo === 'cli');
    assert.ok(cli, 'Missing CLI in the metapackage');
    cli.sha = (await request(`/repos/${OWNER}/cli/branches/master`)).commit.sha;
    cli.manifest = JSON.parse(await fileAt('cli', cli.sha, 'package.json', request));
    const registry = yaml.load(fs.readFileSync('dependency-policy.yml', 'utf8')).entries;
    const selected = [];
    const excluded = [];

    for (const repo of repos) {
        assert.ok(
            graph.some((item) => item.repo === repo),
            `Unregistered target ${repo}`,
        );
        const current = (await request(`/repos/${OWNER}/${repo}/branches/master`)).commit.sha;
        const pulls = await pages(
            `/repos/${OWNER}/${repo}/pulls?state=open&base=master&sort=created&direction=asc`,
            request,
        );
        for (const pr of pulls.filter(
            (item) =>
                item.user?.login === 'dependabot[bot]' && (!prNumber || item.number === prNumber),
        )) {
            try {
                assert.equal(pr.base.sha, current, 'Refresh the PR against current master first');
                const files = await pages(
                    `/repos/${OWNER}/${repo}/pulls/${pr.number}/files`,
                    request,
                );
                const [before, after, oldLock, newLock] = await Promise.all([
                    fileAt(repo, pr.base.sha, 'package.json', request),
                    fileAt(repo, pr.head.sha, 'package.json', request),
                    fileAt(repo, pr.base.sha, 'package-lock.json', request),
                    fileAt(repo, pr.head.sha, 'package-lock.json', request),
                ]).then((items) => items.map(JSON.parse));
                const assessment = assess(pr, files, before, after, oldLock, newLock, registry);
                assert.equal(
                    graph.find((node) => node.repo === repo).manifest.version,
                    after.version,
                    'Update metapackage submodules before this pilot',
                );
                const checks = await fetchCheckRuns(env.GH_TOKEN, OWNER, repo, pr.head.sha);
                const required = await fetchRequiredChecks(env.GH_TOKEN, OWNER, repo, 'master');
                assert.ok(
                    deriveChecksGreen(checks, required, pr.head.sha),
                    'Required exact-head CI is not green',
                );
                const item = {
                    repo,
                    number: pr.number,
                    sha: pr.head.sha,
                    baseSha: pr.base.sha,
                    manifest: after,
                    risk: assessment.maxRisk,
                    profile: assessment.verificationProfile,
                };
                selected.push(item);
                Object.assign(
                    graph.find((node) => node.repo === repo),
                    {sha: item.sha, manifest: after},
                );
                break;
            } catch (error) {
                excluded.push({repo, number: pr.number, reason: error.message.slice(0, 400)});
            }
        }
    }
    const moscowDate = new Date(Date.now() + 3 * 60 * 60_000).toISOString().slice(0, 10);
    const plan = {
        schema: 1,
        toolSha: env.GITHUB_SHA,
        metapackageSha,
        readyBy: `${moscowDate}T05:00:00.000Z`,
        cli: structuredClone(cli),
        graph,
        selected,
        excluded,
    };
    plan.id = planId(plan);
    if (selected.length) buildOrder(graph, selected);
    return validatePlan(plan);
}

function renderSelection(plan) {
    const clean = (value) => String(value).replace(/[|\r\n]/g, ' ');
    const lines = [
        '## Morning candidate selection',
        '',
        `Target readiness: **08:00 Europe/Moscow** (${plan.readyBy}).`,
        '',
        plan.selected.length
            ? `${plan.selected.length} source PR(s) selected; **not yet verified**.`
            : 'No eligible updates selected. **No candidate has been validated.**',
        '',
        '| Source | Exact head | Risk |',
        '| --- | --- | --- |',
    ];
    for (const item of plan.selected) {
        lines.push(`| ${item.repo}#${item.number} | \`${item.sha}\` | ${clean(item.risk)} |`);
    }
    if (plan.excluded.length) {
        lines.push('', '### Excluded candidates', '');
        for (const item of plan.excluded)
            lines.push(`- ${item.repo}#${item.number}: ${clean(item.reason)}`);
    }
    return lines.join('\n') + '\n';
}

if (require.main === module) {
    planTrain()
        .then((plan) => {
            write('train-plan.json', plan);
            fs.appendFileSync(process.env.GITHUB_OUTPUT, `selected=${plan.selected.length}\n`);
            fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, renderSelection(plan));
        })
        .catch((error) => {
            console.error(error.message);
            process.exitCode = 1;
        });
}

module.exports = {allowlist, assess, graphAt, planTrain, renderSelection};
