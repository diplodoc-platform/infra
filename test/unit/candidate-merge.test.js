const assert = require('node:assert/strict');
const {planId, digest} = require('../../scripts/candidate-train/common');
const {
    VERIFIER_APP_ID,
    VERDICT_MARKER,
    sources,
    verifiedVerdict,
} = require('../../scripts/candidate-train/verdict');
const {mergeTrain} = require('../../scripts/candidate-train/merge');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const tests = [];
const test = (name, fn) => tests.push({name, fn});

function fixture() {
    const node = (repo, sha, dependencies) => ({
        repo,
        sha: sha.repeat(40),
        manifest: {name: `@diplodoc/${repo}`, version: '1.0.0', dependencies},
    });
    const alpha = node('alpha', 'a', {shared: '^1.1.0'});
    const beta = node('beta', 'b', {shared: '^1.1.0', '@diplodoc/alpha': '*'});
    const cli = node('cli', 'e', {'@diplodoc/beta': '*'});
    const plan = {
        schema: 2,
        toolSha: 'd'.repeat(40),
        metapackageSha: 'c'.repeat(40),
        cli,
        graph: [alpha, beta, cli],
        readyBy: '2026-11-17T05:00:00Z',
        selected: [alpha, beta].map((item, i) => ({
            ...item,
            number: i + 1,
            baseSha: String(i + 1).repeat(40),
            risk: 'low',
            profile: 'ecosystem',
        })),
        cohort: {
            requests: [
                {repo: 'alpha', number: 1},
                {repo: 'beta', number: 2},
            ],
            dependency: {name: 'shared', version: '1.1.0'},
        },
    };
    plan.id = planId(plan);
    const planBytes = JSON.stringify(plan);
    const proofBytes = JSON.stringify({
        schema: 3,
        trainId: plan.id,
        toolSha: plan.toolSha,
        cliBaseSha: cli.sha,
    });
    const candidate = {owner: 'diplodoc-platform', repo: 'cli', number: 42, sha: 'f'.repeat(40)};
    const verdict = {
        schema: 1,
        trainId: plan.id,
        candidate,
        planSha256: digest(planBytes),
        payloadSha256: digest(proofBytes),
        toolSha: plan.toolSha,
        cliBaseSha: cli.sha,
        sources: sources(plan),
        evidence: {version: 1, launch: 7, installed: true, documents: true},
    };
    const check = {
        id: 10,
        name: 'Internal check',
        app: {id: VERIFIER_APP_ID},
        head_sha: candidate.sha,
        status: 'completed',
        conclusion: 'success',
        output: {text: `Completed\n${VERDICT_MARKER}\n${JSON.stringify(verdict)}`},
    };
    const pulls = new Map(
        plan.selected.map((item) => [
            item.repo,
            {
                number: item.number,
                state: 'open',
                merged: false,
                draft: false,
                head: {sha: item.sha, repo: {full_name: `diplodoc-platform/${item.repo}`}},
                base: {
                    sha: item.baseSha,
                    ref: 'master',
                    repo: {full_name: `diplodoc-platform/${item.repo}`},
                },
            },
        ]),
    );
    pulls.set('cli', {
        number: 42,
        state: 'open',
        merged: false,
        user: {login: 'diplodoc-bot'},
        head: {
            sha: candidate.sha,
            ref: `codex/dependency-candidate-${plan.id}`,
            repo: {full_name: 'diplodoc-platform/cli'},
        },
        base: {sha: cli.sha, ref: 'master', repo: {full_name: 'diplodoc-platform/cli'}},
    });
    const state = {
        plan,
        planBytes,
        proofBytes,
        candidate,
        verdict,
        checks: [check],
        pulls,
        writes: [],
        reports: [],
        review: 'APPROVED',
        mergeState: 'CLEAN',
        failRepo: '',
        badCi: '',
        mergeSettings: new Map(),
        mergeRules: new Map(),
        commits: new Map(),
        metaSha: plan.metapackageSha,
        cliBase: cli.sha,
        advancedRepo: '',
        deniedRepo: '',
        operatorId: 7,
        authorization: undefined,
        revokeAfterMerge: false,
    };
    const registrations = plan.graph.map(({repo, sha}) => ({
        directory: `packages/${repo}`,
        repo,
        sha,
    }));
    state.metapackages = new Map([
        [plan.metapackageSha, {registrations, infraSha: '7'.repeat(40)}],
    ]);
    const blob = (content) => ({
        encoding: 'base64',
        size: content.length,
        content: Buffer.from(content).toString('base64'),
    });
    const request = async (route, options = {}) => {
        if (route === '/graphql') {
            const item = plan.selected.find(
                (source) => source.repo === options.body.variables.repo,
            );
            return {
                data: {
                    repository: {
                        pullRequest: {
                            headRefOid: item.sha,
                            baseRefOid: item.baseSha,
                            reviewDecision: state.review,
                            mergeStateStatus: state.mergeState,
                        },
                    },
                },
            };
        }
        const parts = route.split('/');
        const repo = parts[3];
        const tail = parts.slice(4).join('/');
        if (!tail) return state.mergeSettings.get(repo) || {allow_squash_merge: true};
        if (tail.split('?')[0] === 'rules/branches/master') return state.mergeRules.get(repo) || [];
        if (tail.startsWith('collaborators/'))
            return {
                permission: repo === state.deniedRepo ? 'read' : 'write',
                user: {login: 'maintainer', id: state.operatorId, type: 'User'},
            };
        if (tail.startsWith('check-runs/')) return state.authorization;
        if (options.method === 'PUT') {
            state.writes.push({repo, ...options});
            if (repo === state.failRepo) throw new Error('Simulated merge failure');
            const item = plan.selected.find((source) => source.repo === repo);
            assert.equal(options.body.sha, item.sha);
            const commit = String(item.number + 2).repeat(40);
            Object.assign(pulls.get(repo), {
                merged: true,
                state: 'closed',
                merge_commit_sha: commit,
            });
            if (state.revokeAfterMerge) state.deniedRepo = 'beta';
            return {merged: true, sha: commit};
        }
        if (tail.startsWith('pulls/')) return structuredClone(pulls.get(repo));
        if (tail === 'branches/master')
            return {
                commit: {
                    sha:
                        repo === 'cli'
                            ? state.cliBase
                            : repo === 'diplodoc'
                              ? state.metaSha
                              : repo === state.advancedRepo
                                ? '9'.repeat(40)
                                : pulls.get(repo).merged
                                  ? pulls.get(repo).merge_commit_sha
                                  : plan.selected.find((item) => item.repo === repo).baseSha,
                },
            };
        if (repo === 'diplodoc' && tail.startsWith('git/')) {
            const sha = tail.split('/').at(-1).split('?')[0];
            const revision = state.metapackages.get(sha);
            assert.ok(revision, `Unexpected metapackage revision ${sha}`);
            if (tail.endsWith('?recursive=1')) {
                return {
                    truncated: Boolean(revision.truncated),
                    tree: [
                        ...revision.registrations.map(({directory, sha}) => ({
                            path: directory,
                            type: 'commit',
                            sha,
                        })),
                        {path: 'devops/infra', type: 'commit', sha: revision.infraSha},
                    ],
                };
            }
            if (tail.startsWith('git/trees/')) {
                return {truncated: false, tree: [{path: '.gitmodules', type: 'blob', sha}]};
            }
            const modules = [
                ...revision.registrations,
                {directory: 'devops/infra', repo: 'infra'},
            ].map(
                ({directory, repo}) =>
                    `[submodule "${directory}"]\n path = ${directory}\n url = https://github.com/diplodoc-platform/${repo}.git\n`,
            );
            return blob(modules.join(''));
        }
        if (tail === `git/trees/${candidate.sha}`)
            return {
                truncated: false,
                tree: [
                    {path: 'dependency-train', type: 'tree', mode: '040000', sha: '0'.repeat(40)},
                ],
            };
        if (tail === `git/trees/${'0'.repeat(40)}`)
            return {
                truncated: false,
                tree: ['plan.json', 'proof.json'].map((path, i) => ({
                    path,
                    type: 'blob',
                    mode: '100644',
                    sha: String(i + 6).repeat(40),
                })),
            };
        if (tail === `git/blobs/${'6'.repeat(40)}`) return blob(planBytes);
        if (tail === `git/blobs/${'7'.repeat(40)}`) return blob(proofBytes);
        if (tail === `git/commits/${candidate.sha}`) return {parents: [{sha: cli.sha}]};
        if (tail.startsWith('git/commits/'))
            return (
                state.commits.get(`${repo}:${tail.split('/').at(-1)}`) || {
                    parents: [{sha: plan.selected.find((item) => item.repo === repo).baseSha}],
                }
            );
        assert.fail(`Unexpected request ${route}`);
    };
    const evidence = {
        fetchCheckRuns: async (_token, _owner, repo, sha) => ({
            check_runs:
                repo === 'cli'
                    ? state.checks
                    : repo === state.badCi
                      ? []
                      : [
                            {
                                id: 1,
                                name: 'Quality',
                                app: {id: 15368},
                                head_sha: sha,
                                status: 'completed',
                                conclusion: 'success',
                            },
                        ],
        }),
        fetchRequiredChecks: async () => [{context: 'Quality', appId: 15368}],
    };
    const env = {
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_ACTOR: 'maintainer',
        CANDIDATE_PR: '42',
        CONFIRM_TRAIN_ID: plan.id,
    };
    state.request = request;
    state.evidence = evidence;
    state.environment = env;
    state.verified = {plan, verdict, candidate, checkId: 10};
    state.run = (live = false, overrides = {}) =>
        mergeTrain(
            {...env, DEPENDENCY_TRAIN_MERGE_APPROVED: String(live), ...overrides},
            state.request,
            evidence,
            (report) => state.reports.push(structuredClone(report)),
        );
    return state;
}

test('dry-run preflights all sources and performs no writes', async () => {
    const f = fixture();
    const report = await f.run();
    assert.equal(report.sources.length, 2);
    assert.deepEqual(f.writes, []);
});

test('live merge needs no strict branch policy and leaves candidate cleanup to submodule sync', async () => {
    const f = fixture();
    const result = await f.run(true);
    assert.equal(result.complete, true);
    assert.deepEqual(
        f.writes.map((item) => [item.repo, item.method]),
        [
            ['alpha', 'PUT'],
            ['beta', 'PUT'],
        ],
    );
    assert.equal(f.pulls.get('cli').state, 'open');
});

test('partial failure persists exact progress; rerun independently verifies merged sources and does not merge them twice', async () => {
    const f = fixture();
    f.failRepo = 'beta';
    await assert.rejects(f.run(true), /Simulated/);
    assert.equal(f.reports.at(-1).sources[0].merged, true);
    assert.equal(f.pulls.get('cli').state, 'open');
    f.failRepo = '';
    await f.run(true);
    assert.equal(
        f.writes.filter((item) => item.repo === 'alpha' && item.method === 'PUT').length,
        1,
    );
});

function twoCommitRebase(f) {
    const alpha = f.plan.selected.find((item) => item.repo === 'alpha');
    const sourceParent = 'ab'.repeat(20);
    const mergedParent = 'cd'.repeat(20);
    const mergedTip = '3'.repeat(40);
    const add = (sha, parent, tree) =>
        f.commits.set(`alpha:${sha}`, {parents: [{sha: parent}], tree: {sha: tree.repeat(40)}});

    f.pulls.get('alpha').commits = 2;
    f.pulls.get('alpha').rebaseable = true;
    f.mergeSettings.set('alpha', {allow_squash_merge: false, allow_rebase_merge: true});
    add(alpha.sha, sourceParent, 'd');
    add(sourceParent, alpha.baseSha, 'e');
    add(mergedTip, mergedParent, 'd');
    add(mergedParent, alpha.baseSha, 'e');

    return {alpha, mergedParent};
}

test('preview selects rebase in a rebase-only repo and partial resume verifies the two landed commits', async () => {
    const f = fixture();
    twoCommitRebase(f);
    const preview = await f.run();
    assert.deepEqual(
        preview.sources.map((item) => item.mergeMethod),
        ['rebase', 'squash'],
    );
    assert.deepEqual(f.writes, []);

    f.failRepo = 'beta';
    await assert.rejects(f.run(true), /Simulated/);
    assert.equal(f.writes[0].body.merge_method, 'rebase');
    f.failRepo = '';
    assert.equal((await f.run(true)).complete, true);
    assert.deepEqual(
        f.writes.map(({repo}) => repo),
        ['alpha', 'beta', 'beta'],
    );
});

test('branch merge rules and repository settings must agree before any source is merged', async () => {
    const f = fixture();
    f.mergeRules.set('beta', [
        {type: 'pull_request', parameters: {allowed_merge_methods: ['rebase']}},
    ]);

    await assert.rejects(f.run(), /beta: GitHub does not allow squash or rebase/);
    await assert.rejects(f.run(true), /beta: GitHub does not allow squash or rebase/);
    assert.deepEqual(f.writes, []);
});

test('rebase preflight rejects a PR on the wrong base and landed tree drift stops later writes', async () => {
    const f = fixture();
    const {alpha, mergedParent} = twoCommitRebase(f);
    f.pulls.get('alpha').rebaseable = false;
    await assert.rejects(f.run(true), /GitHub has not confirmed that this PR can be rebased/);
    assert.deepEqual(f.writes, []);

    f.pulls.get('alpha').rebaseable = true;
    const parent = f.commits.get(`alpha:${alpha.sha}`).parents[0].sha;
    const first = f.commits.get(`alpha:${parent}`);
    first.parents[0].sha = '9'.repeat(40);
    await assert.rejects(f.run(true), /rebase history must start at the verified base/);
    assert.deepEqual(f.writes, []);

    first.parents[0].sha = alpha.baseSha;
    f.commits.get(`alpha:${mergedParent}`).tree.sha = '9'.repeat(40);
    await assert.rejects(f.run(true), /rebased tree differs from the verified PR/);
    assert.deepEqual(
        f.writes.map(({repo}) => repo),
        ['alpha'],
    );
    await assert.rejects(f.run(true), /rebased tree differs from the verified PR/);
    assert.deepEqual(
        f.writes.map(({repo}) => repo),
        ['alpha'],
    );
});

for (const [name, mutate] of [
    [
        'source head',
        (f) => {
            f.pulls.get('beta').head.sha = '9'.repeat(40);
        },
    ],
    [
        'review',
        (f) => {
            f.review = 'REVIEW_REQUIRED';
        },
    ],
    [
        'CI',
        (f) => {
            f.badCi = 'beta';
        },
    ],
    [
        'merge gate',
        (f) => {
            f.mergeState = 'BLOCKED';
        },
    ],
    [
        'CLI baseline even with equivalent metapackage inputs',
        (f) => {
            f.metaSha = '9'.repeat(40);
            f.metapackages.set(f.metaSha, f.metapackages.get(f.plan.metapackageSha));
            f.cliBase = '8'.repeat(40);
        },
    ],
    [
        'candidate author',
        (f) => {
            f.pulls.get('cli').user.login = 'outsider';
        },
    ],
    [
        'new pending attempt',
        (f) => {
            f.checks.push({...f.checks[0], id: 11, status: 'in_progress'});
        },
    ],
])
    test(`${name} blocks the entire group before its first merge`, async () => {
        const f = fixture();
        mutate(f);
        await assert.rejects(f.run(true));
        assert.deepEqual(f.writes, []);
    });

test('preview and merge accept a metapackage commit that only updates infra', async () => {
    const f = fixture();
    f.metaSha = '9'.repeat(40);
    const frozen = f.metapackages.get(f.plan.metapackageSha);
    f.metapackages.set(f.metaSha, {...frozen, infraSha: '8'.repeat(40)});

    const preview = await f.run();
    assert.equal(preview.sources.length, 2);
    assert.deepEqual(f.writes, []);
    const report = await f.run(true);
    assert.equal(report.complete, true);
    assert.deepEqual(
        f.writes.map(({repo}) => repo),
        ['alpha', 'beta'],
    );
});

for (const [change, mutate] of [
    [
        'gitlink update',
        (items) => {
            items[0].sha = '8'.repeat(40);
        },
    ],
    [
        'repository remap',
        (items) => {
            items[0].repo = 'other';
        },
    ],
    [
        'registration removal',
        (items) => {
            items.shift();
        },
    ],
    [
        'registration addition',
        (items) => {
            items.push({directory: 'extensions/extra', repo: 'extra', sha: '8'.repeat(40)});
        },
    ],
]) {
    test(`a metapackage ${change} blocks both preview and live merge`, async () => {
        const f = fixture();
        f.metaSha = '9'.repeat(40);
        const current = structuredClone(f.metapackages.get(f.plan.metapackageSha));
        mutate(current.registrations);
        f.metapackages.set(f.metaSha, current);

        for (const live of [false, true]) {
            await assert.rejects(f.run(live), /diplodoc package input changed.*rebuild the train/);
            assert.deepEqual(f.writes, []);
        }
    });
}

test('a truncated metapackage tree cannot prove equivalent inputs', async () => {
    const f = fixture();
    f.metaSha = '9'.repeat(40);
    f.metapackages.set(f.metaSha, {...f.metapackages.get(f.plan.metapackageSha), truncated: true});

    await assert.rejects(f.run(true), /Incomplete metapackage tree/);
    assert.deepEqual(f.writes, []);
});

test('a generic green check, forged App and mismatched evidence cannot authorize a merge', () => {
    for (const mutate of [
        (f) => {
            f.checks[0].output.text = 'all good';
        },
        (f) => {
            f.checks[0].app.id = 1;
        },
        (f) => {
            f.checks[0].conclusion = 'cancelled';
        },
        (f) => {
            f.verdict.payloadSha256 = '0'.repeat(64);
        },
        (f) => {
            f.verdict.sources[1].sha = '9'.repeat(40);
        },
        (f) => {
            f.verdict.evidence.documents = false;
        },
        (f) => {
            f.verdict.evidence.installed = false;
        },
    ]) {
        const f = fixture();
        mutate(f);
        if (f.checks[0].output.text !== 'all good')
            f.checks[0].output.text = `Completed\n${VERDICT_MARKER}\n${JSON.stringify(f.verdict)}`;
        assert.throws(() => verifiedVerdict(f.checks, f.candidate, f.planBytes, f.proofBytes));
    }
});

test('scheduled, bot-triggered or unconfirmed live merges are rejected', async () => {
    for (const values of [
        {GITHUB_EVENT_NAME: 'schedule'},
        {GITHUB_ACTOR: 'github-actions[bot]'},
        {CONFIRM_TRAIN_ID: ''},
    ]) {
        const f = fixture();
        await assert.rejects(f.run(true, values));
        assert.deepEqual(f.writes, []);
    }
});

test('a changed or reverted merged group member blocks partial resume before another write', async () => {
    const f = fixture();
    f.failRepo = 'beta';
    await assert.rejects(f.run(true), /Simulated/);
    f.failRepo = '';
    f.advancedRepo = 'alpha';
    const writes = f.writes.length;
    await assert.rejects(f.run(true), /previously merged source advanced/);
    assert.equal(f.writes.length, writes);
});

test('a target base change during the final group reads stops the merge', async () => {
    const f = fixture();
    const request = f.request;
    let betaReviewReads = 0;
    f.request = async (route, options) => {
        const response = await request(route, options);
        if (route === '/graphql' && options.body.variables.repo === 'beta') {
            betaReviewReads++;
            if (betaReviewReads === 2) f.advancedRepo = 'alpha';
        }
        return response;
    };

    await assert.rejects(f.run(true), /alpha: source base changed/);
    assert.deepEqual(f.writes, []);
});

test('a base race between the final read and merge records partial progress and stops the group', async () => {
    const f = fixture();
    const request = f.request;
    f.request = async (route, options) => {
        const mergeCommit = f.pulls.get('alpha').merge_commit_sha;
        if (mergeCommit && route === `/repos/diplodoc-platform/alpha/git/commits/${mergeCommit}`) {
            return {parents: [{sha: '9'.repeat(40)}]};
        }
        return request(route, options);
    };

    await assert.rejects(f.run(true), /alpha: merged baseline differs/);
    assert.deepEqual(
        f.writes.map(({repo}) => repo),
        ['alpha'],
    );
    assert.equal(f.reports.at(-1).sources[0].merged, true);
    assert.equal(f.pulls.get('cli').state, 'open');
});

test('merge workflow is manual-only with read-only scoped preview and separate write authorization', () => {
    const workflow = yaml.load(
        fs.readFileSync(
            path.join(__dirname, '../../.github/workflows/merge-verified-train.yml'),
            'utf8',
        ),
    );
    assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
    assert.equal(workflow.on.workflow_dispatch.inputs.dry_run.default, true);
    assert.deepEqual(workflow.permissions, {contents: 'read'});
    for (const step of workflow.jobs.preview.steps.filter((step) =>
        step.uses?.startsWith('actions/create-github-app-token@'),
    )) {
        const permissions = Object.entries(step.with).filter(([key]) =>
            key.startsWith('permission-'),
        );
        assert.ok(permissions.length > 0 && permissions.every(([, value]) => value === 'read'));
    }
    assert.equal(
        workflow.jobs.preview.steps.find((step) => step.id === 'candidate-reader').with
            .repositories,
        'cli',
    );
    assert.equal(
        workflow.jobs.preview.steps.find((step) => step.id === 'inventory').run,
        'node scripts/candidate-train/merge.js inventory',
    );
    assert.equal(
        workflow.jobs.preview.steps.find((step) => step.id === 'reader').with.repositories,
        '${{ steps.inventory.outputs.read-repositories }}',
    );
    assert.ok(workflow.jobs.merge.if.includes('inputs.dry_run == false'));
    assert.ok(
        workflow.jobs.merge.if.includes(
            'inputs.confirm_train_id == needs.preview.outputs.train-id',
        ),
    );
    assert.equal(workflow.concurrency.group, 'dependency-candidate-train');
    const token = workflow.jobs.merge.steps.find((step) => step.id === 'app');
    assert.equal(token.with.repositories, '${{ needs.preview.outputs.repositories }}');
    assert.equal(
        workflow.jobs.merge.steps.find(
            (step) => step.env?.GH_TOKEN === '${{ steps.app.outputs.token }}',
        ).run,
        'node scripts/candidate-train/merge.js',
    );
});

module.exports = {tests, fixture};
