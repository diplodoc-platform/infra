'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const {isDeepStrictEqual} = require('node:util');
const {
    OWNER,
    SHA,
    fileAt,
    github,
    pages,
    read,
    write,
    buildOrder,
    validatePlan,
} = require('./common');
const {approvalRepositories} = require('./approval-scope');
const {planTrain, assess} = require('./plan');
const {readPolicy} = require('./prepare-lock');
const {assertPreparedCI} = require('./prepare-ci');
const {BOT} = require('./prepare-policy');
const {
    MAX_EXTRA_DEPENDENCIES,
    APP_RECONCILE_REPO,
    APP_RECONCILE_AUTHOR,
    reconciliationSeed,
    reconciliationBranch,
    reconcileLock,
    packageName,
} = require('./reconcile-lock');
const {withArchives, assertDependencyDelta} = require('./build');
const {runtimeArtifacts} = require('./artifacts');
const {assembleCliLock} = require('./cli-lock');
const {groupRisk} = require('./risk');

function gitHubReader(env) {
    return (route, options) => github(route, {...options, token: env.GH_TOKEN});
}

async function selectGroup(env, request) {
    const manual = env.DEPENDENCY_TRAIN_COHORT_PRS?.trim();
    const target = env.DEPENDENCY_TRAIN_RECONCILE_TARGET || '';
    assert.equal(
        Boolean(manual),
        Boolean(target),
        'Supply both source PRs and an exact name@version target, or neither',
    );
    const name = target.slice(0, target.lastIndexOf('@'));
    const plan = await planTrain(
        {
            ...env,
            DEPENDENCY_TRAIN_SELECTION_MODE: 'cohort',
            DEPENDENCY_TRAIN_COHORT_DEPENDENCY: name,
        },
        request,
    );
    if (!plan.selected.length) return null;
    assert.ok(plan.cohort?.dependency);
    const {dependency} = plan.cohort;
    if (target) assert.equal(`${dependency.name}@${dependency.version}`, target);
    return plan;
}

/** Render canonical replacements for a single, already complete group. No package code runs. */
async function planReconciliation(plan, maxRisk, request) {
    if (!plan) return {proposals: [], blockers: []};
    validatePlan(plan);
    assert.equal(plan.schema, 2);
    const {dependency} = plan.cohort;
    assert.ok(dependency);
    const readFile = (repo, sha, file) => fileAt(repo, sha, file, request);
    const cli = await readFile('cli', plan.cli.sha, 'package-lock.json').then(JSON.parse);
    const proposals = [];
    const locks = new Map();
    const registry = readPolicy();

    for (const node of buildOrder(plan.graph, plan.selected)) {
        if (node.repo === 'cli') continue;
        const head = await readFile(node.repo, node.sha, 'package-lock.json').then(JSON.parse);
        locks.set(node.repo, head);
        const source = plan.selected.find(({repo}) => repo === node.repo);
        if (!source) continue;

        const prefix = `/repos/${OWNER}/${node.repo}`;
        const pr = await request(`${prefix}/pulls/${source.number}`);
        assert.equal(pr.state, 'open');
        assert.equal(pr.draft, false);
        assert.equal(pr.base.sha, source.baseSha);
        assert.equal(pr.head.sha, source.sha);
        assert.equal(pr.head.repo?.full_name, `${OWNER}/${node.repo}`);
        if (reconciliationSeed(pr) || pr.user?.login !== 'dependabot[bot]') continue;
        assert.equal(pr.base.ref, 'master');
        assert.equal(pr.base.repo?.full_name, `${OWNER}/${node.repo}`);
        assert.equal((await request(`${prefix}/branches/master`)).commit.sha, source.baseSha);

        const [old, before, after, files] = await Promise.all([
            readFile(node.repo, source.baseSha, 'package-lock.json').then(JSON.parse),
            readFile(node.repo, source.baseSha, 'package.json').then(JSON.parse),
            readFile(node.repo, source.sha, 'package.json'),
            pages(`${prefix}/pulls/${source.number}/files`, request),
        ]);
        const manifest = JSON.parse(after);
        assert.deepEqual(manifest, source.manifest);
        const {lock, changes} = reconcileLock(old, head, cli, plan.cli.manifest, dependency.name);
        if (!changes.length) continue;
        const candidateFiles = files.some(({filename}) => filename === 'package-lock.json')
            ? files
            : [...files, {filename: 'package-lock.json', status: 'modified'}];
        const assessment = assess(pr, candidateFiles, before, manifest, old, lock, registry, {
            maxRisk,
            reconciled: true,
        });
        locks.set(node.repo, lock);
        proposals.push({
            repo: node.repo,
            number: source.number,
            sha: source.sha,
            baseSha: source.baseSha,
            ...(!isDeepStrictEqual(before, manifest) ? {manifest: after} : {}),
            lock,
            changes,
            risk: assessment.maxRisk,
        });
    }
    const extra = new Set(proposals.flatMap(({changes}) => changes.map(({name}) => name)));
    assert.ok(
        extra.size <= MAX_EXTRA_DEPENDENCIES,
        'More than five additional dependencies in the group',
    );
    if (!proposals.length) return {proposals, blockers: []};

    // Exercise the same canonical graph comparison as the builder and publisher.
    const archives = new Map(
        runtimeArtifacts(plan).map((node) => [
            node.manifest.name,
            {...node, lock: locks.get(node.repo)},
        ]),
    );
    assert.ok(
        proposals.every(({repo}) => [...archives.values()].some((node) => node.repo === repo)),
        'Automatic reconciliation requires a verified CLI runtime archive',
    );
    const effective = withArchives(plan.cli.manifest, archives, undefined, true);
    const assembled = assembleCliLock(cli, effective, archives, () => Buffer.alloc(0), true);
    assertDependencyDelta(plan, cli, assembled, locks, undefined, true);

    const blockers = [];
    for (const item of proposals) {
        const prefix = `/repos/${OWNER}/${item.repo}`;
        for (const check of [
            () => assertPreparedCI(item.repo, item.baseSha, request),
            async () => {
                const existing = await checkPublication(prefix, item, request);
                if (existing) item.existing = existing;
            },
        ]) {
            try {
                await check();
            } catch (error) {
                blockers.push({repo: item.repo, reason: error.message});
            }
        }
    }

    return {proposals, blockers};
}

async function checkPublication(prefix, item, request) {
    const branch = reconciliationBranch(item.number, item.sha);
    const previous = await pages(
        `${prefix}/pulls?state=all&head=${OWNER}:${encodeURIComponent(branch)}`,
        request,
    );
    assert.ok(previous.length <= 1, `${item.repo}: ambiguous reconciliation PRs`);
    const existing = previous[0];
    if (existing) {
        assert.equal(
            existing.state,
            'open',
            `${item.repo}: a reconciliation PR was deliberately closed`,
        );
        assert.equal(existing.draft, false);
        assert.equal(existing.base.sha, item.baseSha);
        assert.equal(existing.head.repo?.full_name, `${OWNER}/${item.repo}`);
        assert.deepEqual(reconciliationSeed(existing), {number: item.number, sha: item.sha});
        const [manifest, seedManifest] = await Promise.all(
            [existing.head.sha, item.sha].map((sha) =>
                fileAt(item.repo, sha, 'package.json', request).then(JSON.parse),
            ),
        );
        assert.deepEqual(manifest, seedManifest, 'Existing reconciliation changed the manifest');
        assert.deepEqual(
            await fileAt(item.repo, existing.head.sha, 'package-lock.json', request).then(
                JSON.parse,
            ),
            item.lock,
            'Existing reconciliation changed',
        );
        return existing.number;
    }
    const open = await pages(`${prefix}/pulls?state=open&base=master`, request);
    const names = new Set(item.changes.map(({name}) => name));

    for (const pr of open) {
        if (pr.number === item.number) continue;
        const files = await pages(`${prefix}/pulls/${pr.number}/files`, request);
        if (
            !files.some(
                ({filename}) => filename === 'package-lock.json' || filename === 'package.json',
            )
        )
            continue;

        assert.match(pr.base.sha, SHA);
        assert.match(pr.head.sha, SHA);
        const {merge_base_commit: base} = await request(
            `${prefix}/compare/${pr.base.sha}...${pr.head.sha}?per_page=1`,
        );
        assert.match(base?.sha, SHA);
        const [before, after] = await Promise.all(
            [base.sha, pr.head.sha].map((sha) =>
                fileAt(item.repo, sha, 'package-lock.json', request).then(JSON.parse),
            ),
        );
        const keys = new Set([...Object.keys(before.packages), ...Object.keys(after.packages)]);
        for (const key of keys) {
            const name = packageName(key);
            if (!names.has(name)) continue;
            assert.ok(
                before.packages[key]?.version === after.packages[key]?.version,
                `${item.repo}#${pr.number} already changes ${name}`,
            );
        }
    }
}

async function publishReconciliation(report, env, request = github) {
    assert.equal(env.GITHUB_REPOSITORY, `${OWNER}/infra`);
    assert.equal(env.GITHUB_REF, 'refs/heads/master');
    assert.equal(env.DEPENDENCY_TRAIN_RECONCILE_APPROVED, 'true');
    assert.equal(report.plan?.toolSha, env.GITHUB_SHA);
    const reader = (route, options) => request(route, {...options, token: env.GH_TOKEN});
    const botRequest = (route, options) =>
        request(route, {...options, token: env.TRAIN_REFRESH_TOKEN});
    const appRequest = (route, options) =>
        request(route, {...options, token: env.TRAIN_GROUP_APP_TOKEN});
    const plan = await selectGroup(env, reader);
    for (const key of ['id', 'toolSha', 'metapackageSha', 'cli', 'selected', 'cohort', 'graph'])
        assert.deepEqual(plan?.[key], report.plan[key], 'Selection changed; rerun reconciliation');
    const canonical = await planReconciliation(
        plan,
        env.DEPENDENCY_TRAIN_MAX_RISK || groupRisk(plan.selected),
        reader,
    );
    assert.deepEqual(canonical, {proposals: report.proposals, blockers: report.blockers});
    const pending = canonical.proposals.filter(({existing}) => !existing);
    assert.ok(pending.length && !canonical.blockers.length);
    assert.equal(env.DEPENDENCY_TRAIN_RECONCILE_REPOS, pending.map(({repo}) => repo).join(','));

    const appAuthorEnabled = approvalRepositories(
        env.DEPENDENCY_TRAIN_BOT_APPROVAL_REPOSITORIES,
        plan.graph,
    ).has(APP_RECONCILE_REPO);
    let bot;
    if (!appAuthorEnabled || pending.some(({repo}) => repo !== APP_RECONCILE_REPO)) {
        bot = await botRequest('/user');
        assert.equal(bot.login, BOT);
        assert.ok(Number.isSafeInteger(bot.id) && bot.id > 0);
    }

    const opened = [];
    for (const item of pending) {
        const appAuthored = appAuthorEnabled && item.repo === APP_RECONCILE_REPO;
        opened.push(
            await openReconciliation(
                item,
                plan.cohort.dependency,
                appAuthored ? undefined : bot,
                reader,
                appRequest,
                appAuthored ? appRequest : botRequest,
            ),
        );
    }
    return opened;
}

async function openReconciliation(item, dependency, bot, request, appRequest, opener) {
    const prefix = `/repos/${OWNER}/${item.repo}`;
    const author = bot ? BOT : APP_RECONCILE_AUTHOR;
    const branch = reconciliationBranch(item.number, item.sha);
    const title = `chore(deps): reconcile ${dependency.name}@${dependency.version} with the CLI lock`;
    const contents = [
        {
            path: 'package-lock.json',
            mode: '100644',
            type: 'blob',
            content: JSON.stringify(item.lock, null, 2) + '\n',
        },
    ];
    if (item.manifest)
        contents.push({path: 'package.json', mode: '100644', type: 'blob', content: item.manifest});
    const base = await request(`${prefix}/git/commits/${item.baseSha}`);
    const tree = await appRequest(`${prefix}/git/trees`, {
        method: 'POST',
        body: {base_tree: base.tree.sha, tree: contents},
    });
    assert.match(tree.sha, SHA);
    const commit = await appRequest(`${prefix}/git/commits`, {
        method: 'POST',
        body: {
            message: title,
            tree: tree.sha,
            parents: [item.baseSha],
            ...(bot
                ? {author: {name: BOT, email: `${bot.id}+${BOT}@users.noreply.github.com`}}
                : {}),
        },
    });
    const seed = await request(`${prefix}/pulls/${item.number}`);
    assert.equal(seed.state, 'open');
    assert.equal(seed.head.sha, item.sha);
    assert.equal(seed.base.sha, item.baseSha);
    assert.equal((await request(`${prefix}/branches/master`)).commit.sha, item.baseSha);
    assert.match(commit.sha, SHA);
    let head = commit.sha;
    try {
        await appRequest(`${prefix}/git/refs`, {
            method: 'POST',
            body: {ref: `refs/heads/${branch}`, sha: head},
        });
    } catch (error) {
        if (error.status !== 422) throw error;
        const ref = await request(`${prefix}/git/ref/heads/${branch}`);
        head = ref.object.sha;
        assert.match(head, SHA);
        const existing = await request(`${prefix}/git/commits/${head}`);
        assert.equal(
            existing.tree.sha,
            tree.sha,
            'Previous reconciliation branch has another tree',
        );
        assert.deepEqual(
            existing.parents.map(({sha}) => sha),
            [item.baseSha],
        );
    }
    const changes = item.changes.map(({key, from, to}) => `- \`${key}\` \`${from}\` → \`${to}\``);
    const pr = await opener(`${prefix}/pulls`, {
        method: 'POST',
        body: {
            head: branch,
            base: 'master',
            title,
            body: [
                `Reconciles #${item.number} at \`${item.sha}\` with the frozen CLI providers.`,
                ...changes,
                '',
                'The candidate train still requires green exact-head CI and Internal Check before a human can merge it.',
            ].join('\n'),
        },
    });
    assert.equal(pr.user?.login, author);
    assert.equal(pr.head.sha, head);
    assert.equal(pr.base.sha, item.baseSha);
    assert.deepEqual(reconciliationSeed(pr), {number: item.number, sha: item.sha});
    return `https://github.com/${OWNER}/${item.repo}/pull/${pr.number}`;
}

async function run(env) {
    const file = 'dependency-reconciliation.json';
    const summary = (lines) => fs.appendFileSync(env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
    if (process.argv[2] === 'apply') {
        const opened = await publishReconciliation(read(file), env);
        summary(opened.map((url) => `- Opened ${url}`));
        return;
    }
    const request = gitHubReader(env);
    const plan = await selectGroup(env, request);
    const {proposals, blockers} = await planReconciliation(
        plan,
        env.DEPENDENCY_TRAIN_MAX_RISK || (plan ? groupRisk(plan.selected) : 'low'),
        request,
    );
    write(file, {plan, proposals, blockers});
    fs.appendFileSync(
        env.GITHUB_OUTPUT,
        `repositories=${
            blockers.length
                ? ''
                : proposals
                      .filter(({existing}) => !existing)
                      .map(({repo}) => repo)
                      .join(',')
        }\n`,
    );
    summary([
        '### Dependency reconciliation',
        ...proposals.flatMap(({repo, changes}) =>
            changes.map(({key, from, to}) => `- ${repo}: \`${key}\` ${from} → ${to}`),
        ),
        ...blockers.map(
            ({repo, reason}) => `- ${repo}: ${reason.replace(/[\r\n]+/g, ' ').slice(0, 350)}`,
        ),
        ...(proposals.length ? [] : ['No additional CLI-pinned dependencies to reconcile.']),
    ]);
}

if (require.main === module) {
    run(process.env).catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = {openReconciliation, planReconciliation, publishReconciliation};
