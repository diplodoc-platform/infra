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
const {planCohort} = require('./cohort-plan');
const {changedInput, automaticGroups} = require('./automatic-groups');
const {declares} = require('./cohort');
const {riskSelection, groupRisk, assertRiskAllowed} = require('./risk');
const {requireDeepProfile} = require('./deep-profile');
const {DEEP_PROFILES} = require('../dependency-verification-profiles');
const {
    isPreparedSource,
    sourceHeadRepo,
    preparedBranch,
    validatePreparedLock,
} = require('./prepare-policy');
const {findPreparation} = require('./prepare-plan');
const {packageRegistrationsAt} = require('./metapackage');

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

function assess(
    pr,
    files,
    before,
    after,
    oldLock,
    newLock,
    registry,
    {manual = false, dependency = '', maxRisk = 'low'} = {},
) {
    const prepared = isPreparedSource(pr);
    if (!manual)
        assert.ok(pr.user?.login === 'dependabot[bot]' || prepared, 'Unexpected source author');
    assert.equal(pr.state, 'open');
    assert.equal(pr.draft, false);
    assert.equal(pr.base.ref, 'master');
    assert.equal(pr.head.repo?.full_name, sourceHeadRepo(pr, pr.base.repo.name));
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
    const strippedAfter = strip(after);
    if (
        manual &&
        dependency &&
        !isDeepStrictEqual(before.overrides?.[dependency], after.overrides?.[dependency])
    ) {
        assert.equal(
            typeof before.overrides?.[dependency],
            'string',
            'Only an existing direct dependency override may follow its cohort update',
        );
        assert.ok(
            SECTIONS.some(
                (section) =>
                    Object.hasOwn(before[section] || {}, dependency) &&
                    after[section]?.[dependency] === after.overrides?.[dependency],
            ),
            'Cohort override must match its direct dependency declaration',
        );
        strippedAfter.overrides = {...after.overrides, [dependency]: before.overrides[dependency]};
    }
    assert.ok(isDeepStrictEqual(strip(before), strippedAfter), 'Non-dependency manifest changes');
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
    assertRiskAllowed(assessment.maxRisk, maxRisk);
    if (prepared) {
        assert.deepEqual(before, after, 'Prepared PR must preserve package.json');
        assert.deepEqual(
            files.map(({filename}) => filename),
            ['package-lock.json'],
        );
        const target = changedInput(before, after, oldLock, newLock);
        assert.equal(pr.head.ref, preparedBranch(target));
        validatePreparedLock(before, oldLock, newLock, target);
        assert.ok(
            !DEEP_PROFILES.includes(assessment.verificationProfile),
            'Prepared PR requires a Dependabot-only deep profile',
        );
    }
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
    const registrations = await packageRegistrationsAt(sha, request);
    const graph = [];
    for (const {repo, sha: commit} of registrations.values()) {
        const manifest = JSON.parse(await fileAt(repo, commit, 'package.json', request));
        graph.push({repo, sha: commit, manifest});
    }
    return graph;
}

async function planTrain(
    env = process.env,
    request = (route) => github(route, {token: env.GH_TOKEN}),
    evidence = {fetchCheckRuns, fetchRequiredChecks},
    {refresh = false, prepareMissing = false, target = ''} = {},
) {
    if (env.DEPENDENCY_TRAIN_COHORT_PRS?.trim()) {
        assert.ok(!refresh, 'Refresh only supports automatically discovered groups');
        return planCohort(env, request, evidence, {
            graphAt,
            assess,
            risk: riskSelection(env, 'cohort'),
        });
    }
    assert.ok(
        !env.DEPENDENCY_TRAIN_COHORT_DEPENDENCY?.trim(),
        'A shared dependency requires explicit cohort PRs',
    );
    const requested = allowlist(env.DEPENDENCY_TRAIN_REPOSITORIES);
    const prNumber = Number(env.DEPENDENCY_TRAIN_PR_NUMBER || 0);
    const waveNumber = Number(env.DEPENDENCY_TRAIN_WAVE || 1);
    const mode = env.DEPENDENCY_TRAIN_SELECTION_MODE || 'wave';
    assert.ok(['wave', 'cohort'].includes(mode), 'Unknown candidate selection mode');
    if (refresh) assert.equal(mode, 'cohort');
    assert.ok(!prepareMissing || refresh, 'Missing-source preparation belongs to Refresh');
    if (target) {
        assert.ok(prepareMissing, 'Enable missing-source preparation to select a target');
        const separator = target.lastIndexOf('@');
        assert.ok(separator > 0, 'Use an exact package@version target');
        preparedBranch({name: target.slice(0, separator), version: target.slice(separator + 1)});
    }
    const risk = riskSelection(env, mode);
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
    const inputs = new Map();
    const excluded = [];
    const sourceFiles = new Map();
    const masters = new Map();
    const openPulls = new Map();
    const readSource = (repo, sha, filename) => {
        const key = `${repo}:${sha}:${filename}`;

        if (!sourceFiles.has(key)) sourceFiles.set(key, fileAt(repo, sha, filename, request));

        return sourceFiles.get(key);
    };

    for (const repo of repos) {
        const current = (await request(`/repos/${OWNER}/${repo}/branches/master`)).commit.sha;
        masters.set(repo, current);
        let requiredChecks;
        const pulls = await pages(
            `/repos/${OWNER}/${repo}/pulls?state=open&base=master&sort=created&direction=asc`,
            request,
        );
        if (prepareMissing) openPulls.set(repo, pulls);
        for (const pr of pulls.filter(
            (item) =>
                (item.user?.login === 'dependabot[bot]' ||
                    (mode === 'cohort' && isPreparedSource(item))) &&
                (!prNumber || item.number === prNumber),
        )) {
            assert.ok(
                inventory.length + excluded.length < INVENTORY_LIMIT,
                'Candidate inventory exceeds the size limit',
            );

            try {
                const stale = pr.base.sha !== current;
                if (stale && !refresh)
                    assert.equal(
                        pr.base.sha,
                        current,
                        'Refresh the PR against current master first',
                    );
                if (stale) {
                    const source = await request(`/repos/${OWNER}/${repo}/pulls/${pr.number}`);
                    assert.ok(
                        source.head.sha === pr.head.sha &&
                            source.base.sha === pr.base.sha &&
                            source.rebaseable === true &&
                            source.commits === 1 &&
                            (source.head.ref?.startsWith('dependabot/') ||
                                isPreparedSource(source)),
                        'Stale source has no verified single-commit rebase',
                    );
                }
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
                const assessment = assess(pr, files, before, after, oldLock, newLock, registry, {
                    maxRisk: risk.maxRisk,
                });
                if (mode === 'cohort')
                    inputs.set(
                        `${repo}#${pr.number}`,
                        changedInput(before, after, oldLock, newLock),
                    );
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
                    ...(isPreparedSource(pr) ? {prepared: true} : {}),
                    repo,
                    number: pr.number,
                    sha: pr.head.sha,
                    baseSha: pr.base.sha,
                    ...(stale ? {refreshTo: current} : {}),
                    manifest: after,
                    risk: assessment.maxRisk,
                    profile: assessment.verificationProfile,
                    createdAt: new Date(pr.created_at).toISOString(),
                };
                await requireDeepProfile(item, checks, request);
                inventory.push(item);
            } catch (error) {
                excluded.push({repo, number: pr.number, reason: error.message.slice(0, 400)});
            }
        }
    }

    let automaticReport;
    if (mode === 'cohort') {
        assert.equal(prNumber, 0, 'Use explicit cohort PRs for manual source selection');
        const baselines = new Map();
        for (const name of new Set([...inputs.values()].map((input) => input.name))) {
            for (const node of graph.filter(
                (item) => !['cli', 'vsc'].includes(item.repo) && declares(item.manifest, name),
            )) {
                const current =
                    masters.get(node.repo) ||
                    (await request(`/repos/${OWNER}/${node.repo}/branches/master`)).commit.sha;
                if (current !== node.sha) continue;
                const lock = JSON.parse(await readSource(node.repo, node.sha, 'package-lock.json'));
                baselines.set(`${node.repo}:${name}`, {
                    sha: node.sha,
                    version: lock.packages[`node_modules/${name}`]?.version,
                });
            }
        }
        const {
            groups,
            incomplete,
            excluded: blockedGroups,
        } = automaticGroups(graph, inventory, inputs, repos, baselines);
        const eligibleGroups = risk.exact
            ? groups.filter((group) => group.risk === risk.exact)
            : groups;
        automaticReport = {groups: eligibleGroups, excluded: blockedGroups, riskSelection: risk};
        if (refresh) {
            const matchesTarget = ({dependency}) =>
                !target || target === `${dependency.name}@${dependency.version}`;
            const sources = new Map(inventory.map((item) => [`${item.repo}#${item.number}`, item]));
            const describe = (group) => ({
                dependency: group.dependency,
                risk: group.risk,
                sources: group.requests.map(({repo, number}) => {
                    const {sha, baseSha, refreshTo, prepared} = sources.get(`${repo}#${number}`);
                    return {
                        repo,
                        number,
                        sha,
                        baseSha,
                        ...(refreshTo ? {refreshTo} : {}),
                        ...(prepared ? {prepared} : {}),
                    };
                }),
                baseline: group.baseline || [],
                ...(group.missing ? {missing: group.missing} : {}),
            });
            const complete = eligibleGroups.filter(matchesTarget);
            let group = complete.find(({requests}) =>
                requests.some(({repo, number}) => sources.get(`${repo}#${number}`).refreshTo),
            );
            let preparationBlocked;
            if (!group && prepareMissing && !complete.length) {
                const active = new Set(
                    [...openPulls.values()]
                        .flat()
                        .filter(isPreparedSource)
                        .map((pr) => pr.head.ref),
                );
                const candidates = incomplete.filter(matchesTarget);
                const waiting = candidates.filter(({dependency}) =>
                    active.has(preparedBranch(dependency)),
                );
                const preparation = await findPreparation(
                    !target && waiting.length ? waiting : candidates,
                    graph,
                    masters,
                    openPulls,
                    readSource,
                    request,
                );
                group = preparation.group;
                preparationBlocked = preparation.blocked;
            }
            return {
                toolSha: env.GITHUB_SHA,
                metapackageSha,
                group: group ? describe(group) : null,
                excluded,
                blockedGroups,
                ...(preparationBlocked ? {preparationBlocked} : {}),
            };
        }
        assert.ok(
            waveNumber <= Math.max(1, automaticReport.groups.length),
            'Group index is out of range',
        );
        const group = automaticReport.groups[waveNumber - 1];
        if (group) {
            const plan = await planCohort(
                {
                    ...env,
                    DEPENDENCY_TRAIN_WAVE: '1',
                    DEPENDENCY_TRAIN_COHORT_PRS: group.requests
                        .map(({repo, number}) => `${repo}#${number}`)
                        .join(','),
                    DEPENDENCY_TRAIN_COHORT_DEPENDENCY: group.dependency.name,
                },
                request,
                evidence,
                {graphAt, assess, risk, automatic: true, baseline: group.baseline || []},
            );
            return {...plan, automaticGroups: automaticReport, excluded};
        }
    }
    const waves = mode === 'cohort' ? [] : candidateWaves(inventory);
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
        inventory: (mode === 'cohort' ? [] : inventory).map(candidateIdentity),
        waves: waves.map((wave) => wave.map(candidateIdentity)),
        selection: {
            wave: waveNumber,
            totalWaves: waves.length,
            waveSize: WAVE_SIZE,
            eligibleCount: mode === 'cohort' ? 0 : inventory.length,
            repositories: repos,
            unsupported,
        },
    };
    if (automaticReport) plan.automaticGroups = automaticReport;
    plan.id = planId(plan);
    if (selected.length) buildOrder(graph, selected);
    return validatePlan(plan);
}

function renderSelection(plan) {
    if (plan.schema === 2) {
        return [
            plan.automaticGroups
                ? '## Automatic coordinated dependency group'
                : '## Manual dependency cohort',
            '',
            `${plan.selected.length} exact source PRs; the group is indivisible and is **not yet verified**.`,
            ...(plan.cohort.dependency
                ? [
                      `Shared dependency: **${plan.cohort.dependency.name}@${plan.cohort.dependency.version}**.`,
                      '',
                  ]
                : []),
            `Group risk: **${groupRisk(plan.selected)}**.`,
            '',
            '| Source | Exact head | Risk | Profile |',
            '| --- | --- | --- | --- |',
            ...plan.selected.map(
                (node) =>
                    `| ${node.repo}#${node.number} | \`${node.sha}\` | ${node.risk} | ${node.profile} |`,
            ),
            '',
            `Build order: ${buildOrder(plan.graph, plan.selected)
                .map((node) => node.repo)
                .join(' → ')}.`,
            '',
            'All selected packages and affected consumers share one candidate. Direct CLI and VSC updates retain their separate verification paths. No merge, release or schedule is enabled.',
            '',
        ].join('\n');
    }
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

    if (plan.automaticGroups) {
        const {riskSelection: risk, groups} = plan.automaticGroups;
        lines.push(
            '',
            `Complete coordinated groups: **${groups.length}**. ` +
                (risk.exact
                    ? `Exact risk: **${risk.exact}**.`
                    : `Risk ceiling: **${risk.maxRisk}**.`),
        );
    }

    if (plan.selection && !plan.automaticGroups) {
        const waveLabel = plan.selection.totalWaves
            ? `Wave **${plan.selection.wave}/${plan.selection.totalWaves}**; `
            : 'No eligible waves; ';
        lines.push(
            '',
            `Inventory scope: **${plan.selection.repositories.length} repositories** ` +
                `(${plan.selection.repositories.join(', ')}). Direct CLI and VSC updates are excluded.`,
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
    if (plan.automaticGroups?.excluded.length) {
        lines.push('', '### Blocked coordinated groups', '');
        for (const item of plan.automaticGroups.excluded.slice(0, SUMMARY_LIMIT)) {
            lines.push(
                `- ${clean(item.dependency.name)}@${clean(item.dependency.version)}: ${clean(item.reason)}`,
            );
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
