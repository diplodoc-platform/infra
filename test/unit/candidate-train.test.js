const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {runInNewContext} = require('node:vm');
const yaml = require('js-yaml');

const common = require('../../scripts/candidate-train/common');
const planner = require('../../scripts/candidate-train/plan');
const builder = require('../../scripts/candidate-train/build');
const publisher = require('../../scripts/candidate-train/publish');
const internal = require('../../scripts/candidate-train/internal');
const {notify} = require('../../scripts/candidate-train/notify');
const observer = require('../../scripts/candidate-train/observe');

const tests = [];
const test = (name, fn) => tests.push({name, fn});
const SHA = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const root = path.join(__dirname, '../..');
const node = (repo, dependencies = {}, devDependencies = {}) => ({
    repo,
    sha: SHA,
    manifest: {name: `@diplodoc/${repo}`, version: '1.0.0', dependencies, devDependencies},
});

function fixturePlan() {
    const graph = [
        node('utils'),
        node('transform', {'@diplodoc/utils': '^1.0.0'}),
        node('cli', {'@diplodoc/transform': '^1.0.0'}, {}),
    ];
    const selected = [{...graph[0], number: 3, baseSha: SHA}];
    const plan = {
        schema: 1,
        toolSha: SHA,
        metapackageSha: SHA,
        cli: graph[2],
        graph,
        selected,
        readyBy: '2026-10-21T05:00:00.000Z',
    };
    plan.id = common.planId(plan);
    return plan;
}

function fixturePr() {
    return {
        number: 3,
        state: 'open',
        draft: false,
        user: {login: 'dependabot[bot]'},
        base: {ref: 'master', repo: {name: 'utils'}, sha: SHA},
        head: {sha: HEAD, repo: {full_name: 'diplodoc-platform/utils'}},
    };
}

function lock(manifest, version = '1.0.0') {
    return {
        lockfileVersion: 3,
        packages: {'': structuredClone(manifest), 'node_modules/parser': {version}},
    };
}

test('candidate allowlist is explicit, bounded, unique and excludes direct CLI updates', () => {
    assert.deepEqual(planner.allowlist('cut-extension, utils'), ['cut-extension', 'utils']);
    for (const value of ['', 'cli', 'utils,utils', '../utils', 'a,b,c,d']) {
        assert.throws(() => planner.allowlist(value));
    }
});

test('selection reports do not confuse an empty or planned train with successful validation', () => {
    const plan = fixturePlan();
    plan.excluded = [];
    assert.match(planner.renderSelection(plan), /not yet verified/);
    plan.selected = [];
    assert.match(planner.renderSelection(plan), /No candidate has been validated/);
});

test('registered unrelated packages may have an unscoped npm name', () => {
    const plan = fixturePlan();
    const extension = node('vscode-extension');
    extension.manifest.name = 'diplodoc-vsc-extension';
    plan.graph.push(extension);
    assert.equal(common.validatePlan(plan), plan);
    assert.deepEqual(
        common.buildOrder(plan.graph, plan.selected).map((item) => item.repo),
        ['utils', 'transform', 'cli'],
    );
});

test('real Dependabot manifest and lock-only minor changes are selected', () => {
    const before = {name: '@diplodoc/utils', dependencies: {parser: '^1.0.0'}};
    const after = {...before, dependencies: {parser: '^1.1.0'}};
    for (const manifest of [after, before]) {
        const result = planner.assess(
            fixturePr(),
            [{filename: 'package-lock.json', status: 'modified'}],
            before,
            manifest,
            lock(before),
            lock(manifest, '1.1.0'),
            [],
        );
        assert.ok(result.summary.total > 0);
    }
});

test('selection rejects forged authors, stale locks, script edits, majors and workflow changes', () => {
    const before = {name: '@diplodoc/utils', dependencies: {parser: '^1.0.0'}};
    const after = {...before, dependencies: {parser: '^1.1.0'}};
    const files = [{filename: 'package-lock.json', status: 'modified'}];
    const run = (pr, changed, manifest, targetLock = lock(manifest, '1.1.0')) =>
        planner.assess(pr, changed, before, manifest, lock(before), targetLock, []);
    assert.throws(() => run({...fixturePr(), user: {login: 'someone'}}, files, after));
    assert.throws(() => run(fixturePr(), files, {...after, scripts: {prepare: 'bad'}}));
    assert.throws(() => run(fixturePr(), [{filename: '.github/workflows/x.yml'}], after));
    assert.throws(() => run(fixturePr(), files, after, lock(before)));
    const major = {...after, dependencies: {parser: '^2.0.0'}};
    assert.throws(() => run(fixturePr(), files, major, lock(major, '2.0.0')));
});

test('build graph rebuilds every affected runtime consumer through CLI', () => {
    const plan = fixturePlan();
    assert.deepEqual(
        common.buildOrder(plan.graph, plan.selected).map((item) => item.repo),
        ['utils', 'transform', 'cli'],
    );
    assert.throws(() => common.buildOrder([...plan.graph, node('unrelated')], [node('unrelated')]));
});

test('components cannot be substituted without rebuilding client browser/SSR assets', () => {
    const graph = [
        node('components'),
        node('client', {}, {'@diplodoc/components': '^1.0.0'}),
        node('cli', {'@diplodoc/client': '^1.0.0'}),
    ];
    assert.deepEqual(
        common.buildOrder(graph, [graph[0]]).map((item) => item.repo),
        ['components', 'client', 'cli'],
    );
});

test('affected build cycles fail closed', () => {
    const graph = [
        node('a', {'@diplodoc/b': '^1.0.0'}),
        node('b', {'@diplodoc/a': '^1.0.0'}),
        node('cli', {'@diplodoc/a': '^1.0.0'}),
    ];
    assert.throws(() => common.buildOrder(graph, [graph[0]]));
});

test('archive specs are relocatable and preserve unrelated scripts and nested overrides', () => {
    const manifest = {
        dependencies: {'@diplodoc/utils': '^1.0.0'},
        scripts: {prepare: 'custom'},
        overrides: {'@diplodoc/utils': {parser: '1.2.3'}, other: '2.0.0'},
    };
    const result = builder.withArchives(manifest, new Map([['@diplodoc/utils', {repo: 'utils'}]]));
    assert.equal(result.dependencies['@diplodoc/utils'], 'file:dependency-train/payload/utils.tgz');
    assert.deepEqual(result.overrides['@diplodoc/utils'], {
        parser: '1.2.3',
        '.': result.dependencies['@diplodoc/utils'],
    });
    assert.deepEqual(result.scripts, manifest.scripts);
    assert.equal(result.overrides.other, '2.0.0');
});

test('installed-resolution proof rejects a silent fallback to another locked version', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-resolution-test-'));
    fs.mkdirSync(path.join(directory, 'node_modules/parser'), {recursive: true});
    common.write(path.join(directory, 'node_modules/parser/package.json'), {
        name: 'parser',
        version: '1.0.0',
    });
    assert.throws(() =>
        builder.verifyLockedTree(directory, directory, lock({}, '1.1.0'), new Set()),
    );
    assert.equal(builder.verifyLockedTree(directory, directory, lock({}), new Set()).length, 1);
});

test('publisher accepts only canonical dependency payloads and rejects scripts, extra files and symlinks', () => {
    const plan = fixturePlan();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-payload-test-'));
    const order = common
        .buildOrder(plan.graph, plan.selected)
        .filter((item) => item.repo !== 'cli');
    fs.mkdirSync(path.join(directory, 'dependency-train/payload'), {recursive: true});
    const manifest = builder.withArchives(
        plan.cli.manifest,
        new Map(order.map((item) => [item.manifest.name, item])),
    );
    manifest.files = ['dependency-train'];
    common.write(path.join(directory, 'package.json'), manifest);
    common.write(path.join(directory, 'package-lock.json'), lock(manifest));
    const packages = order.map((item) => {
        const bytes = Buffer.from(item.repo);
        fs.writeFileSync(path.join(directory, `dependency-train/payload/${item.repo}.tgz`), bytes);
        return {
            repo: item.repo,
            name: item.manifest.name,
            sourceSha: item.sha,
            archiveSha256: common.digest(bytes),
            resolutions: [],
        };
    });
    common.write(path.join(directory, 'dependency-train/proof.json'), {
        schema: 1,
        trainId: plan.id,
        toolSha: SHA,
        cliBaseSha: SHA,
        packages,
    });
    assert.equal(publisher.validatePayload(plan, directory).length, 5);
    common.write(path.join(directory, 'package.json'), {...manifest, scripts: {prepare: 'bad'}});
    assert.throws(() => publisher.validatePayload(plan, directory));
    common.write(path.join(directory, 'package.json'), manifest);
    fs.writeFileSync(path.join(directory, 'extra.js'), 'bad');
    assert.throws(() => publisher.validatePayload(plan, directory));
    fs.unlinkSync(path.join(directory, 'extra.js'));
    if (process.platform !== 'win32') {
        fs.symlinkSync(path.join(directory, 'package.json'), path.join(directory, 'unexpected'));
        assert.throws(() => publisher.validatePayload(plan, directory));
    }
});

test('Internal evidence must bind the right CLI SHA, PR, branch and non-skipped tests', () => {
    const candidate = {sha: HEAD, number: 42, branch: 'codex/dependency-candidate-test'};
    const flow = (vars) => ({flow_launch_state: {flow_vars: {json: JSON.stringify(vars)}}});
    const vars = {
        docsViewer: {sha: HEAD, prNumber: 42},
        branch: candidate.branch,
        skipTests: false,
        updateSnapshots: true,
    };
    internal.boundFlow(flow(vars), candidate);
    assert.throws(() => internal.boundFlow(flow({...vars, skipTests: true}), candidate));
    assert.throws(() =>
        internal.boundFlow(flow({...vars, docsViewer: {sha: SHA, prNumber: 42}}), candidate),
    );
});

test('document-check badge cannot pass as skipped, absent, mixed or superseded', () => {
    const checks = ['build', 'configure', 'tests'].map((type) => ({
        system: 'ci',
        type,
        status: 'success',
        required: true,
        system_check_id: '123',
    }));
    assert.equal(internal.checkSnapshot(checks, {}).green, true);
    assert.equal(
        internal.checkSnapshot(
            checks.map((item) => ({...item, status: 'skipped'})),
            {},
        ).green,
        false,
    );
    assert.throws(() => internal.checkSnapshot([], {}));
    assert.throws(() => internal.checkSnapshot(checks, {badgeId: '456'}));
    assert.throws(() =>
        internal.checkSnapshot([...checks, {...checks[0], system_check_id: '456'}], {}),
    );
});

test('GitHub Internal checks are publisher- and exact-SHA-bound', () => {
    const candidate = {sha: HEAD};
    const check = {
        id: 7,
        head_sha: HEAD,
        app: {id: observer.INTERNAL_APP_ID},
        name: 'Internal check',
    };
    assert.equal(observer.internalCheck([check], candidate, {}).id, 7);
    assert.equal(observer.internalCheck([{...check, app: {id: 999}}], candidate, {}), null);
    assert.equal(observer.internalCheck([{...check, head_sha: SHA}], candidate, {}), null);
    assert.throws(() => observer.internalCheck([{...check, id: 8}], candidate, {checkId: 7}));
});

test('Messenger sends only a private bot notification and treats HTTP 200 errors as failures', async () => {
    const env = {DEPENDENCY_TRAIN_NOTIFY_LOGIN: 'operator', TRAIN_MESSENGER_TOKEN: 'private-token'};
    let sent;
    const transport = async (url, options) => {
        sent = {url, ...options, body: JSON.parse(options.body)};
        return {ok: true, json: async () => ({ok: true, chat: {type: 'private'}, message_id: 1})};
    };
    await notify({id: 'train'}, 'manual-ready', 'Private link', env, transport);
    assert.equal(sent.body.login, 'operator');
    assert.equal(sent.body.payload_id, 'dependency-train:train:manual-ready');
    assert.equal(sent.redirect, 'error');
    assert.equal(sent.headers.Authorization, 'OAuthTeam private-token');
    await assert.rejects(
        notify({id: 'train'}, 'result', 'Failed', env, async () => ({
            ok: true,
            json: async () => ({ok: false}),
        })),
    );
});

test('observer waits for the manual start, reminds at 08:00 and accepts only the final exact-head result', async () => {
    const plan = fixturePlan();
    const candidate = {
        number: 42,
        sha: HEAD,
        branch: `codex/dependency-candidate-${plan.id}`,
        url: 'https://github.com/diplodoc-platform/cli/pull/42',
        plan,
    };
    let clock = Date.parse('2026-10-21T04:59:00.000Z');
    let poll = 0;
    const messages = [];
    const evidence = [];
    const config = {
        apiUrl: 'https://ci.example.test',
        uiOrigin: 'https://review.example.test',
        reviewApiUrl: 'https://review.example.test/api',
        reviewUiOrigin: 'https://review.example.test',
        artifactOrigin: 'https://artifact.example.test',
        configPath: 'project/a.yaml',
        actions: ['prerelease'],
    };
    const quality = {
        id: 10,
        head_sha: HEAD,
        app: {id: 15368},
        name: 'quality',
        status: 'completed',
        conclusion: 'success',
    };
    const source = fixturePr();
    source.head.sha = SHA;
    const result = await observer.observe(
        candidate,
        {
            GITHUB_SHA: SHA,
            DEPENDENCY_CANDIDATE_TRAIN_ENABLED: 'true',
            DEPENDENCY_TRAIN_INTERNAL: JSON.stringify(config),
        },
        {
            now: () => clock,
            sleep: async (ms) => {
                clock += ms;
            },
            persist: (state) => evidence.push(state),
            request: async (route) =>
                route.endsWith('/utils/pulls/3')
                    ? source
                    : {
                          state: 'open',
                          head: {
                              sha: HEAD,
                              ref: candidate.branch,
                              repo: {full_name: 'diplodoc-platform/cli'},
                          },
                      },
            checks: async () => {
                poll++;
                return {
                    check_runs: [
                        quality,
                        {
                            id: 20,
                            head_sha: HEAD,
                            name: 'Internal check',
                            app: {id: observer.INTERNAL_APP_ID},
                            status: poll >= 3 ? 'completed' : 'in_progress',
                            conclusion: poll >= 3 ? 'success' : null,
                        },
                    ],
                };
            },
            inspect: async () => ({
                state: poll >= 3 ? 'documents-passed' : 'waiting-for-manual-start',
                manualStartUrl: 'https://private.example.test/review/123/merge-checks',
            }),
            required: async () => [{context: 'quality', appId: 15368}],
            sourceRequired: async () => [{context: 'quality', appId: 15368}],
            sourceChecks: async () => ({check_runs: [{...quality, head_sha: SHA}]}),
            notify: async (_, event, text) => messages.push({event, text}),
        },
    );
    assert.equal(result.state, 'passed');
    assert.equal(result.late, false);
    assert.deepEqual(
        messages.map((item) => item.event),
        ['manual-ready', 'morning-reminder', 'result'],
    );
    assert.ok(messages[0].text.includes('private.example.test'));
    assert.ok(!JSON.stringify(evidence).includes('private.example.test'));
    assert.ok(evidence.some((state) => state.state === 'waiting-for-manual-start'));
});

test('observer cannot certify a stale source PR and reports its failure privately', async () => {
    const plan = fixturePlan();
    const messages = [];
    const evidence = [];
    const candidate = {
        number: 42,
        sha: HEAD,
        branch: 'codex/dependency-candidate-test',
        url: 'https://github.com/diplodoc-platform/cli/pull/42',
        plan,
    };
    const config = {
        apiUrl: 'https://ci.example.test',
        uiOrigin: 'https://review.example.test',
        reviewApiUrl: 'https://review.example.test/api',
        reviewUiOrigin: 'https://review.example.test',
        artifactOrigin: 'https://artifact.example.test',
        configPath: 'project/a.yaml',
        actions: ['prerelease'],
    };
    await assert.rejects(
        observer.observe(
            candidate,
            {
                GITHUB_SHA: SHA,
                DEPENDENCY_CANDIDATE_TRAIN_ENABLED: 'true',
                DEPENDENCY_TRAIN_INTERNAL: JSON.stringify(config),
            },
            {
                request: async () => fixturePr(),
                notify: async (_, event) => messages.push(event),
                persist: (state) => evidence.push(state),
            },
        ),
    );
    assert.deepEqual(messages, ['observer-error']);
    assert.equal(evidence.at(-1).state, 'blocked');
});

test('private adapter binds generated review/diff/badge and requires builder version proof', async () => {
    const plan = fixturePlan();
    const candidate = {
        number: 42,
        sha: HEAD,
        branch: 'codex/dependency-candidate-test',
        payloadSha256: 'payload-digest',
        plan,
    };
    const config = {
        apiUrl: 'https://ci.example.test',
        uiOrigin: 'https://review.example.test',
        reviewApiUrl: 'https://review.example.test/api',
        reviewUiOrigin: 'https://review.example.test',
        artifactOrigin: 'https://artifact.example.test',
        configPath: 'project/a.yaml',
        actions: ['prerelease'],
    };
    const env = {
        DEPENDENCY_TRAIN_INTERNAL: JSON.stringify(config),
        TRAIN_CI_TOKEN: 'ci-secret',
        TRAIN_REVIEW_TOKEN: 'review-secret',
    };
    const check = {
        output: {
            text: 'https://review.example.test/services/project/ci/actions/flow?dir=project&id=prerelease&number=5',
        },
    };
    let hasProof = false;
    const calls = [];
    const fetcher = async (url, options = {}) => {
        calls.push({url, ...options});
        let data;
        if (url.includes('GetFlowLaunch')) {
            data = {
                flow_launch_state: {
                    flow_vars: {
                        json: JSON.stringify({
                            docsViewer: {sha: HEAD, prNumber: 42},
                            branch: candidate.branch,
                            skipTests: false,
                        }),
                    },
                    jobs: {release: {status: 'JOB_STATUS_SUCCESS'}},
                },
            };
        } else if (url.includes('GetJobLaunch')) {
            data = {
                task_badges: [
                    {
                        module_name: 'ARCADIA',
                        url: 'https://artifact.example.test/review/index.html',
                    },
                ],
            };
        } else if (url.endsWith('dependency-train-proof.json')) {
            if (!hasProof) return {status: 404};
            data = {
                schema: 1,
                trainId: plan.id,
                cliSha: HEAD,
                verified: true,
                payloadSha256: candidate.payloadSha256,
            };
        } else if (url.includes('/active-diff?')) {
            data = {data: {id: 7, commit_ids: {merge: SHA}}};
        } else if (url.includes('?fields=id,ci_checks_button')) {
            data = {data: {id: 23, ci_checks_button: {status: 'available'}}};
        } else if (url.endsWith('/checks')) {
            data = {
                data: ['build', 'configure', 'tests'].map((type) => ({
                    system: 'ci',
                    type,
                    required: true,
                    status: 'pending',
                    system_check_id: '123',
                })),
            };
        }
        return {
            status: 200,
            json: async () => data,
            text: async () =>
                '<meta http-equiv="refresh" content="0; url=https://review.example.test/review/23">',
        };
    };
    assert.equal(
        (await internal.inspectInternal(candidate, check, {}, env, fetcher)).state,
        'waiting-for-builder-version-proof',
    );
    hasProof = true;
    const binding = {};
    const state = await internal.inspectInternal(candidate, check, binding, env, fetcher);
    assert.equal(state.state, 'waiting-for-manual-start');
    assert.equal(state.manualStartUrl, 'https://review.example.test/review/23/merge-checks');
    assert.equal(binding.diffId, 7);
    assert.equal(binding.badgeId, '123');
    for (const call of calls) {
        if (call.url.startsWith(config.artifactOrigin)) assert.equal(call.headers, undefined);
        if (call.method === 'POST')
            assert.ok(call.url.includes('GetFlowLaunch') || call.url.includes('GetJobLaunch'));
    }
});

test('scheduled and manual execution default to no candidate creation', () => {
    const workflow = yaml.load(
        fs.readFileSync(
            path.join(root, '.github/workflows/dependency-candidate-train.yml'),
            'utf8',
        ),
    );
    assert.deepEqual(workflow.on.schedule, [{cron: '17 3 * * *'}]);
    assert.equal(workflow.on.workflow_dispatch.inputs.dry_run.default, true);
    for (const enabled of ['', 'false', 'true']) {
        const vars = {DEPENDENCY_CANDIDATE_TRAIN_ENABLED: enabled};
        assert.equal(
            runInNewContext(workflow.jobs.select.if, {github: {event_name: 'schedule'}, vars}),
            enabled === 'true',
        );
        for (const dryRun of ['', true, false]) {
            const actual = runInNewContext(workflow.jobs.preflight.if, {
                needs: {select: {outputs: {selected: '1'}}},
                vars,
                github: {event_name: 'workflow_dispatch'},
                inputs: {dry_run: dryRun},
                toJSON: JSON.stringify,
            });
            assert.equal(actual, enabled === 'true' && dryRun === false);
        }
    }
});

test('candidate execution has no secrets and publishing/observation use fresh immutable tooling', () => {
    const source = fs.readFileSync(
        path.join(root, '.github/workflows/dependency-candidate-train.yml'),
        'utf8',
    );
    const workflow = yaml.load(source);
    assert.ok(!JSON.stringify(workflow.jobs.build).includes('secrets.'));
    assert.ok(!JSON.stringify(workflow.jobs.select).includes('secrets.'));
    for (const job of Object.values(workflow.jobs)) {
        const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
        assert.equal(checkout.with.ref, '${{ github.sha }}');
        assert.equal(checkout.with['persist-credentials'], false);
    }
    assert.equal(
        workflow.jobs.publish.steps.find((step) => step.id === 'app').with.repositories,
        'cli',
    );
    assert.ok(!source.includes('pull_request_target'));
    for (const filename of fs.readdirSync(path.join(root, 'scripts/candidate-train'))) {
        const code = fs.readFileSync(path.join(root, 'scripts/candidate-train', filename), 'utf8');
        assert.doesNotMatch(
            code,
            /\/merges|\/start_ci_checks|StartAction|distribute-infra|npm.*publish/,
        );
    }
});

module.exports = {tests};
