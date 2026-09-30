const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const yaml = require('js-yaml');

const {deriveManifestEvidence} = require('../../scripts/manifest-evidence');
const {
    deriveChecksGreen,
    extractRequiredCheckContexts,
    classifyPrForAutoMerge,
    fetchJsonAtSha,
} = require('../../scripts/auto-merge');
const {previewLocalSync} = require('../../scripts/preview-sync');
const {syncCiGate} = require('../../scripts/sync-ci-gate');

const tests = [];
const test = (name, fn) => tests.push({name, fn});
const SHA = 'a'.repeat(40);
const beforePackage = {name: 'fixture', devDependencies: {eslint: '^8.0.0'}};
const afterPackage = {name: 'fixture', devDependencies: {eslint: '^8.0.1'}};
const beforeLock = {
    lockfileVersion: 3,
    packages: {'': beforePackage, 'node_modules/eslint': {version: '8.0.0'}},
};
const afterLock = {
    lockfileVersion: 3,
    packages: {'': afterPackage, 'node_modules/eslint': {version: '8.0.1'}},
};
const evidence = (values = []) =>
    deriveManifestEvidence(
        ...[beforePackage, afterPackage, beforeLock, afterLock].map(
            (value, index) => values[index] || value,
        ),
    );

test('complete manifests classify a normal devDependency patch even without added section context', () => {
    assert.deepStrictEqual(evidence(), {
        section: 'devDependencies',
        dependency: 'eslint',
        updateType: 'patch',
        newTransitiveDependencies: 0,
    });
});

test('missing, partial and unsupported lockfiles cannot prove zero new dependencies', () => {
    for (const lock of [undefined, {}, {lockfileVersion: 1}, {lockfileVersion: 3, packages: {}}]) {
        const result = deriveManifestEvidence(beforePackage, afterPackage, lock, afterLock);
        assert.strictEqual(result.section, null);
        assert.strictEqual(result.newTransitiveDependencies, null);
    }
});

test('full lockfile additions are detected even when GitHub omitted the patch', () => {
    assert.strictEqual(
        evidence([
            null,
            null,
            null,
            {
                ...afterLock,
                packages: {...afterLock.packages, 'node_modules/new': {version: '1.0.0'}},
            },
        ]).newTransitiveDependencies,
        1,
    );
});

test('manifest metadata or scripts changes and inconsistent lock roots fail closed', () => {
    assert.strictEqual(
        evidence([null, {...afterPackage, scripts: {postinstall: 'unreviewed'}}]).section,
        null,
    );
    assert.strictEqual(
        evidence([
            null,
            null,
            null,
            {...afterLock, packages: {'': {devDependencies: {eslint: '9.0.0'}}}},
        ]).section,
        null,
    );
});

test('manifest-only filenames and a misleading patch cannot bypass missing full evidence', () => {
    const result = classifyPrForAutoMerge(
        {dependency: 'eslint', updateType: 'patch', risk: 'low'},
        [
            {filename: 'package.json', patch: '+ "devDependencies": {'},
            {filename: 'package-lock.json'},
        ],
        {checksGreen: true, newTransitiveCount: 0, ciCompletedAt: '2026-09-01T00:00:00Z'},
    );
    assert.strictEqual(result.evaluation.allowed, false);
});

const required = [{context: 'test', appId: 15368}];
const green = {
    id: 1,
    name: 'test',
    app: {id: 15368},
    head_sha: SHA,
    status: 'completed',
    conclusion: 'success',
};
test('required checks bind to publisher and exact head SHA', () => {
    assert.ok(deriveChecksGreen({check_runs: [green]}, required, SHA));
    for (const run of [
        {...green, app: {id: 7}},
        {...green, head_sha: 'b'.repeat(40)},
        {...green, conclusion: 'skipped'},
        {...green, conclusion: 'neutral'},
    ]) {
        assert.ok(!deriveChecksGreen({check_runs: [run]}, required, SHA));
    }
    assert.ok(!deriveChecksGreen({check_runs: [green]}, ['test'], SHA));
    assert.ok(!deriveChecksGreen({check_runs: [green]}, [{context: 'test', appId: null}], SHA));
});

test('new pending rerun blocks and an unrelated publisher cannot spoof a trusted failure', () => {
    assert.ok(
        !deriveChecksGreen(
            {check_runs: [green, {...green, id: 2, status: 'in_progress', conclusion: null}]},
            required,
            SHA,
        ),
    );
    assert.ok(
        !deriveChecksGreen(
            {
                check_runs: [
                    {...green, conclusion: 'failure'},
                    {...green, id: 2, app: {id: 9}},
                ],
            },
            required,
            SHA,
        ),
    );
});

test('required check extraction preserves both legacy and ruleset publisher identities', () => {
    assert.deepStrictEqual(
        extractRequiredCheckContexts(
            {contexts: ['test'], checks: [{context: 'test', app_id: 15368}]},
            [
                {
                    type: 'required_status_checks',
                    parameters: {required_status_checks: [{context: 'test', integration_id: 7}]},
                },
            ],
        ),
        [
            {context: 'test', appId: 15368},
            {context: 'test', appId: 7},
        ],
    );
});

test('full manifest fetch uses immutable SHA and blob fallback rather than truncated patches', async () => {
    const original = global.fetch;
    const calls = [];
    global.fetch = async (url) => {
        calls.push(url);
        const value =
            calls.length === 1
                ? {type: 'file', encoding: 'none', sha: 'b'.repeat(40)}
                : {
                      encoding: 'base64',
                      content: Buffer.from(JSON.stringify(afterLock)).toString('base64'),
                  };
        return {ok: true, status: 200, text: async () => JSON.stringify(value)};
    };
    try {
        assert.deepStrictEqual(
            await fetchJsonAtSha('test-token', 'owner', 'repo', SHA, 'package-lock.json'),
            afterLock,
        );
        assert.ok(calls[0].endsWith(`?ref=${SHA}`));
        assert.ok(calls[1].includes('/git/blobs/'));
    } finally {
        global.fetch = original;
    }
});

const workflowPath = (name, scaffolding = true) =>
    path.join(
        __dirname,
        '../../',
        scaffolding ? 'scaffolding/.github/workflows/' : '.github/workflows/',
        name,
    );
const readWorkflow = (name, scaffolding = true) =>
    yaml.load(fs.readFileSync(workflowPath(name, scaffolding), 'utf8'));
const deep = readWorkflow('dependency-deep-verification.yml');

test('all policy workflows install only trusted infra and leave PR dependency code unexecuted', () => {
    for (const [name, scaffolding] of [
        ['dependency-deep-verification.yml', true],
        ['dependency-risk-assessment.yml', true],
        ['dependency-policy-check.yml', true],
        ['dependency-risk-assessment.yml', false],
        ['dependency-policy-check.yml', false],
    ]) {
        const workflow = readWorkflow(name, scaffolding);
        const steps = Object.values(workflow.jobs).flatMap((job) => job.steps || []);
        const trusted = steps.find(
            (step) => step.name === 'Checkout trusted dependency policy tooling',
        );
        assert.match(trusted.with.ref, /^[a-f0-9]{40}$/);
        assert.strictEqual(trusted.with.repository, 'diplodoc-platform/infra');
        assert.strictEqual(trusted.with['persist-credentials'], false);
        assert.strictEqual(
            steps.find((step) => step.run === 'npm ci --ignore-scripts')['working-directory'],
            'trusted-infra',
        );
    }
});

function decision(assessment) {
    const outputs = [];
    const step = deep.jobs['classify-dependency-diff'].steps.find(
        (entry) => entry.id === 'decision',
    );
    const source = step.run.split("node <<'NODE'\n")[1].replace(/\nNODE\s*$/, '');
    vm.runInNewContext(source, {
        require: () => ({
            readFileSync: () => JSON.stringify(assessment),
            appendFileSync: (_file, text) => outputs.push(text),
        }),
        process: {env: {EXPECTED_SHA: SHA}},
    });
    return outputs;
}

test('decision schema rejects unknown profile, string booleans, output injection and wrong head', () => {
    const good = {
        summary: {total: 0},
        direct: [],
        transitive: [],
        hasDependencyChanges: false,
        maxRisk: 'low',
        verificationProfile: 'standard-ci',
        headSha: SHA,
    };
    assert.ok(decision(good)[0].includes('run-deep=false'));
    for (const fields of [
        {verificationProfile: 'typo'},
        {verificationProfile: 'standard-ci\nrun-deep=false'},
        {hasDependencyChanges: 'false'},
        {summary: {total: 1}},
        {maxRisk: 'unknown'},
        {headSha: 'b'.repeat(40)},
    ]) {
        assert.throws(() => decision({...good, ...fields}));
    }
    assert.ok(
        decision({
            ...good,
            summary: {total: 1},
            direct: [{}],
            hasDependencyChanges: true,
            verificationProfile: 'document-rendering',
        })[0].includes('run-deep=true'),
    );
});

async function commentScenario(heads, comments = []) {
    const writes = [];
    const workflow = readWorkflow('dependency-risk-comment.yml');
    const source = workflow.jobs.comment.steps.find((entry) => entry.with?.script)?.with.script;
    let read = 0;
    const sandbox = {
        require: () => ({
            lstatSync: () => ({isFile: () => true, size: 100}),
            readFileSync: (file) =>
                file.endsWith('metadata.json')
                    ? JSON.stringify({pr: 42, headSha: SHA})
                    : 'Risk assessment',
        }),
        process: {env: {EXPECTED_PR: '42', EXPECTED_SHA: SHA}},
        context: {repo: {owner: 'owner', repo: 'repo'}},
        core: {info: () => {}},
        github: {
            rest: {
                pulls: {
                    get: async () => ({
                        data: {
                            state: 'open',
                            head: {sha: heads[Math.min(read++, heads.length - 1)]},
                        },
                    }),
                },
                issues: {
                    listComments: 'list',
                    updateComment: async (value) => writes.push({type: 'update', ...value}),
                    createComment: async (value) => writes.push({type: 'create', ...value}),
                },
            },
            paginate: async () => comments,
        },
    };
    await vm.runInNewContext(`(async () => {${source}})()`, sandbox);
    return writes;
}

test('obsolete risk run never updates comments, including head changes during pagination', async () => {
    assert.strictEqual((await commentScenario(['b'.repeat(40)])).length, 0);
    assert.strictEqual((await commentScenario([SHA, 'b'.repeat(40)])).length, 0);
});

test('risk publisher updates only its stable marker and never another Actions comment', async () => {
    const marker = '<!-- diplodoc:dependency-risk-assessment -->';
    const unrelated = {id: 1, user: {login: 'github-actions[bot]'}, body: 'Build comment'};
    const human = {id: 2, user: {login: 'human'}, body: marker};
    assert.strictEqual((await commentScenario([SHA], [unrelated, human]))[0].type, 'create');
    const result = await commentScenario(
        [SHA],
        [unrelated, {id: 3, user: {login: 'github-actions[bot]'}, body: marker}],
    );
    assert.strictEqual(result[0].type, 'update');
    assert.strictEqual(result[0].comment_id, 3);
    assert.ok(result[0].body.includes(SHA));
});

test('local preview preserves dirty user files and cleans only its own disposable copy', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-security-preview-'));
    try {
        fs.writeFileSync(path.join(root, 'package.json'), '{"name":"dirty-user-tree"}\n');
        fs.writeFileSync(path.join(root, 'untracked.txt'), 'important');
        const report = previewLocalSync(
            root,
            (copy) => {
                fs.writeFileSync(path.join(copy, 'package.json'), '{}\n');
                fs.writeFileSync(path.join(copy, 'new.txt'), 'generated');
            },
            (copy) => fs.readFileSync(path.join(copy, 'new.txt'), 'utf8'),
        );
        assert.strictEqual(report, 'generated');
        assert.strictEqual(
            fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
            '{"name":"dirty-user-tree"}\n',
        );
        assert.strictEqual(fs.readFileSync(path.join(root, 'untracked.txt'), 'utf8'), 'important');
        assert.ok(!fs.existsSync(path.join(root, '.git')));
        assert.ok(!fs.existsSync(path.join(root, 'new.txt')));
        assert.throws(() =>
            previewLocalSync(
                root,
                () => {
                    throw new Error('preview failed');
                },
                () => null,
            ),
        );
        assert.strictEqual(fs.readFileSync(path.join(root, 'untracked.txt'), 'utf8'), 'important');
    } finally {
        fs.rmSync(root, {recursive: true, force: true});
    }
});

test('CI gate dry-run reports publisher bindings without writing any ruleset', async () => {
    const original = global.fetch;
    const methods = [];
    global.fetch = async (_url, options) => {
        methods.push(options.method);
        return {ok: true, text: async () => JSON.stringify({default_branch: 'master'})};
    };
    try {
        const result = await syncCiGate({
            token: 'fixture',
            owner: 'owner',
            name: 'repo',
            gate: {rulesetName: 'master CI gate', requiredChecks: ['test']},
            dryRun: true,
        });
        assert.deepStrictEqual(result.required_checks, [{context: 'test', integration_id: 15368}]);
        assert.deepStrictEqual(methods, ['GET']);
    } finally {
        global.fetch = original;
    }
});

test('CI gate publisher updates preserve manual bypass, conditions and other rules', async () => {
    const original = global.fetch;
    const current = {
        id: 41,
        name: 'master CI gate',
        target: 'branch',
        enforcement: 'active',
        conditions: {ref_name: {include: ['refs/heads/master'], exclude: ['refs/heads/manual']}},
        bypass_actors: [{actor_id: 99, actor_type: 'Team', bypass_mode: 'pull_request'}],
        rules: [
            {
                type: 'required_status_checks',
                parameters: {
                    strict_required_status_checks_policy: true,
                    required_status_checks: [{context: 'test'}],
                },
            },
            {type: 'non_fast_forward'},
        ],
    };
    let updated;
    global.fetch = async (url, options) => {
        let data;
        if (options.method === 'PUT') {
            updated = JSON.parse(options.body);
            data = updated;
        } else if (url.endsWith('/rulesets/41')) data = current;
        else if (url.includes('/rulesets?')) data = [{id: 41, name: 'master CI gate'}];
        else data = {default_branch: 'master'};
        return {ok: true, text: async () => JSON.stringify(data)};
    };
    try {
        const result = await syncCiGate({
            token: 'fixture',
            owner: 'owner',
            name: 'repo',
            gate: {rulesetName: 'master CI gate', requiredChecks: ['test']},
            dryRun: false,
        });
        assert.strictEqual(result.status, 'updated');
        assert.deepStrictEqual(updated.bypass_actors, current.bypass_actors);
        assert.deepStrictEqual(updated.conditions, current.conditions);
        assert.deepStrictEqual(updated.rules[1], current.rules[1]);
        assert.strictEqual(updated.rules[0].parameters.strict_required_status_checks_policy, true);
        assert.deepStrictEqual(updated.rules[0].parameters.required_status_checks, [
            {context: 'test', integration_id: 15368},
        ]);
    } finally {
        global.fetch = original;
    }
});

test('privileged automation action references are pinned and App permission breadth stays accepted', () => {
    for (const name of [
        'dependency-health.yml',
        'dependency-auto-merge.yml',
        'sync-ci-gate.yml',
        'distribute-infra.yml',
        'check-pat-expiry.yml',
    ]) {
        const workflow = readWorkflow(name, false);
        for (const job of Object.values(workflow.jobs)) {
            for (const step of job.steps || []) {
                if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/);
                if (step.uses?.startsWith('actions/create-github-app-token@')) {
                    assert.strictEqual(step.with.owner, 'diplodoc-platform');
                    assert.ok(!Object.keys(step.with).some((key) => key.startsWith('permission-')));
                }
            }
        }
    }
});

module.exports = {tests};
