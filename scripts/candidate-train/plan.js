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
const {
    WAVE_SIZE,
    INVENTORY_LIMIT,
    repositoryTargets,
    candidateWaves,
    candidateIdentity,
} = require('./waves');

const SUMMARY_LIMIT = 100;

function allowlist(value) {
    const repos = (value || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    assert.ok(
        repos.length > 0 && repos.length <= 40,
        'An explicit repository allowlist or all is required (at most 40 names)',
    );
    assert.equal(new Set(repos).size, repos.length);
    repos.forEach((repo) => assert.match(repo, REPO));
    assert.ok(
        !repos.includes('cli'),
        'Direct CLI dependency updates need a separate candidate path',
    );
    assert.ok(!repos.includes('all') || repos.length === 1, 'all cannot be combined with names');
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
    assert.equal(assessment.maxRisk, 'low', 'Only low-risk updates are eligible for a train');
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
    evidence = {fetchCheckRuns, fetchRequiredChecks},
) {
    const requested = allowlist(env.DEPENDENCY_TRAIN_REPOSITORIES);
    const prNumber = Number(env.DEPENDENCY_TRAIN_PR_NUMBER || 0);
    const waveNumber = Number(env.DEPENDENCY_TRAIN_WAVE || 1);
    assert.ok(Number.isSafeInteger(prNumber) && prNumber >= 0, 'Invalid source PR number');
    assert.ok(Number.isSafeInteger(waveNumber) && waveNumber > 0, 'Invalid wave number');
    assert.ok(
        prNumber === 0 || (requested.length === 1 && requested[0] !== 'all'),
        'An exact PR requires one repository',
    );
    assert.match(env.GITHUB_SHA, SHA);
    const metapackageSha = (await request(`/repos/${OWNER}/diplodoc/branches/master`)).commit.sha;
    const graph = await graphAt(metapackageSha, request);
    const cli = graph.find((item) => item.repo === 'cli');
    assert.ok(cli, 'Missing CLI in the metapackage');
    cli.sha = (await request(`/repos/${OWNER}/cli/branches/master`)).commit.sha;
    cli.manifest = JSON.parse(await fileAt('cli', cli.sha, 'package.json', request));
    const {repositories: repos, unsupported} = repositoryTargets(graph, requested);
    const registry = yaml.load(fs.readFileSync('dependency-policy.yml', 'utf8')).entries;
    const inventory = [];
    const excluded = [];
    const sourceFiles = new Map();
    const readSource = (repo, sha, filename) => {
        const key = `${repo}:${sha}:${filename}`;

        if (!sourceFiles.has(key)) sourceFiles.set(key, fileAt(repo, sha, filename, request));

        return sourceFiles.get(key);
    };

    for (const repo of repos) {
        const current = (await request(`/repos/${OWNER}/${repo}/branches/master`)).commit.sha;
        let requiredChecks;
        const pulls = await pages(
            `/repos/${OWNER}/${repo}/pulls?state=open&base=master&sort=created&direction=asc`,
            request,
        );
        for (const pr of pulls.filter(
            (item) =>
                item.user?.login === 'dependabot[bot]' && (!prNumber || item.number === prNumber),
        )) {
            assert.ok(
                inventory.length + excluded.length < INVENTORY_LIMIT,
                'Candidate inventory exceeds the size limit',
            );

            try {
                assert.equal(pr.base.sha, current, 'Refresh the PR against current master first');
                const files = await pages(
                    `/repos/${OWNER}/${repo}/pulls/${pr.number}/files`,
                    request,
                );
                const [before, after, oldLock, newLock] = await Promise.all([
                    readSource(repo, pr.base.sha, 'package.json'),
                    readSource(repo, pr.head.sha, 'package.json'),
                    readSource(repo, pr.base.sha, 'package-lock.json'),
                    readSource(repo, pr.head.sha, 'package-lock.json'),
                ]).then((items) => items.map(JSON.parse));
                const assessment = assess(pr, files, before, after, oldLock, newLock, registry);
                assert.equal(
                    graph.find((node) => node.repo === repo).manifest.version,
                    after.version,
                    'Update metapackage submodules before this pilot',
                );
                const checks = await evidence.fetchCheckRuns(
                    env.GH_TOKEN,
                    OWNER,
                    repo,
                    pr.head.sha,
                );
                requiredChecks ||= await evidence.fetchRequiredChecks(
                    env.GH_TOKEN,
                    OWNER,
                    repo,
                    'master',
                );
                assert.ok(
                    deriveChecksGreen(checks, requiredChecks, pr.head.sha),
                    'Required exact-head CI is not green',
                );
                assert.ok(
                    typeof pr.created_at === 'string' && Number.isFinite(Date.parse(pr.created_at)),
                    'Invalid source PR date',
                );
                const item = {
                    repo,
                    number: pr.number,
                    sha: pr.head.sha,
                    baseSha: pr.base.sha,
                    manifest: after,
                    risk: assessment.maxRisk,
                    profile: assessment.verificationProfile,
                    createdAt: new Date(pr.created_at).toISOString(),
                };
                inventory.push(item);
            } catch (error) {
                excluded.push({repo, number: pr.number, reason: error.message.slice(0, 400)});
            }
        }
    }

    const waves = candidateWaves(inventory);
    assert.ok(
        waveNumber <= Math.max(1, waves.length),
        `Wave ${waveNumber} is out of range; inventory contains ${waves.length} wave(s)`,
    );
    const selected = (waves[waveNumber - 1] || []).map(({createdAt, ...item}) => item);

    for (const item of selected) {
        Object.assign(
            graph.find((node) => node.repo === item.repo),
            {
                sha: item.sha,
                manifest: item.manifest,
            },
        );
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
        inventory: inventory.map(candidateIdentity),
        waves: waves.map((wave) => wave.map(candidateIdentity)),
        selection: {
            wave: waveNumber,
            totalWaves: waves.length,
            waveSize: WAVE_SIZE,
            eligibleCount: inventory.length,
            repositories: repos,
            unsupported,
        },
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

    if (plan.selection) {
        const waveLabel = plan.selection.totalWaves
            ? `Wave **${plan.selection.wave}/${plan.selection.totalWaves}**; `
            : 'No eligible waves; ';
        lines.push(
            '',
            waveLabel +
                `${plan.selection.eligibleCount} eligible low-risk PR(s) in the full inventory.`,
            '',
            '### Planned waves',
            '',
            'Each wave is independent, not cumulative. There is no automatic advance or merge. ' +
                'After source merges, refresh remaining PRs and CI, then generate a fresh plan.',
        );

        for (const [index, wave] of plan.waves.slice(0, SUMMARY_LIMIT).entries()) {
            lines.push(
                `- Wave ${index + 1}: ${wave.map((item) => `${item.repo}#${item.number}`).join(', ')}`,
            );
        }

        if (plan.waves.length > SUMMARY_LIMIT) {
            lines.push(
                `- Showing ${SUMMARY_LIMIT}/${plan.waves.length} waves; see the full artifact.`,
            );
        }

        if (plan.selection.unsupported.length) {
            lines.push('', '### Registered packages outside the CLI build graph', '');

            for (const item of plan.selection.unsupported) {
                lines.push(`- ${item.repo}: ${clean(item.reason)}`);
            }
        }
    }
    if (plan.excluded.length) {
        lines.push('', '### Excluded candidates', '');
        for (const item of plan.excluded.slice(0, SUMMARY_LIMIT))
            lines.push(`- ${item.repo}#${item.number}: ${clean(item.reason)}`);

        if (plan.excluded.length > SUMMARY_LIMIT) {
            lines.push(
                `- Showing ${SUMMARY_LIMIT}/${plan.excluded.length} exclusions; see the full artifact.`,
            );
        }
    }

    lines.push(
        '',
        'The full frozen inventory and all exclusions are in artifact **dependency-train-plan**, file `train-plan.json`.',
    );
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
