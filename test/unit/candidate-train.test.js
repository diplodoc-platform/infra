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
    const name = Object.keys(manifest.dependencies || {})[0] || 'parser';
    return {
        lockfileVersion: 3,
        packages: {'': structuredClone(manifest), [`node_modules/${name}`]: {version}},
    };
}

function hoistedLock() {
    return {
        lockfileVersion: 3,
        packages: {
            '': {dependencies: {cheerio: '1.2.0', entities: '4.5.0'}},
            'node_modules/cheerio': {version: '1.2.0', dependencies: {htmlparser2: '10.1.0'}},
            'node_modules/cheerio/node_modules/htmlparser2': {
                version: '10.1.0',
                dependencies: {entities: '7.0.1'},
            },
            'node_modules/cheerio/node_modules/entities': {version: '7.0.1'},
            'node_modules/entities': {version: '4.5.0'},
        },
    };
}

test('runtime proof follows dependency edges and accepts relocated exact versions', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-hoisting-test-'));
    const lock = hoistedLock();
    const oldPath = 'node_modules/cheerio/node_modules/entities';
    const relocated = 'node_modules/cheerio/node_modules/htmlparser2/node_modules/entities';

    for (const [location, manifest] of Object.entries(lock.packages)) {
        if (!location) continue;
        const target = path.join(directory, location === oldPath ? relocated : location);
        fs.mkdirSync(target, {recursive: true});
        common.write(path.join(target, 'package.json'), {
            ...manifest,
            name: location.split('/').at(-1),
        });
    }

    const proof = builder.verifyLockedTree(directory, directory, lock, new Set());
    assert.ok(proof.some((entry) => entry.path === relocated && entry.version === '7.0.1'));
    assert.ok(!proof.some((entry) => entry.path === oldPath));

    common.write(path.join(directory, relocated, 'package.json'), {
        name: 'entities',
        version: '4.5.0',
    });
    assert.throws(
        () => builder.verifyLockedTree(directory, directory, lock, new Set()),
        /Locked resolution mismatch/,
    );

    fs.unlinkSync(path.join(directory, relocated, 'package.json'));
    assert.throws(
        () => builder.verifyLockedTree(directory, directory, lock, new Set()),
        /Locked resolution mismatch/,
    );
    fs.unlinkSync(path.join(directory, 'node_modules/entities/package.json'));
    assert.throws(
        () => builder.verifyLockedTree(directory, directory, lock, new Set()),
        /Missing locked dependency/,
    );
});

test('runtime graph retains distinct consumers, peer edges, optional paths and cycles', () => {
    const lock = hoistedLock();
    lock.packages['node_modules/cheerio'].peerDependencies = {entities: '*'};
    lock.packages['node_modules/cheerio/node_modules/htmlparser2'].dependencies.cheerio = '*';
    lock.packages[''].optionalDependencies = {native: '1.0.0'};
    lock.packages['node_modules/native'] = {version: '1.0.0', dependencies: {entities: '*'}};

    const proof = builder.runtimeVersions(lock, new Set());
    assert.ok(
        proof.some((item) => item.path === 'node_modules/entities' && item.version === '4.5.0'),
    );
    assert.ok(
        proof.some(
            (item) =>
                item.path === 'node_modules/cheerio/node_modules/entities' &&
                item.version === '7.0.1',
        ),
    );
    assert.ok(proof.some((item) => item.path.endsWith('htmlparser2/node_modules/cheerio')));
    assert.ok(
        proof.some(
            (item) => item.path === 'node_modules/native/node_modules/entities' && item.optional,
        ),
    );
    assert.deepEqual(builder.runtimeVersions(lock, new Set(['cheerio', 'entities', 'native'])), []);

    delete lock.packages['node_modules/cheerio/node_modules/htmlparser2'];
    assert.throws(
        () => builder.runtimeVersions(lock, new Set()),
        /Missing locked runtime dependency/,
    );
});

test('runtime proof rejects excessive depth instead of dropping unchecked edges', () => {
    const lock = {lockfileVersion: 3, packages: {'': {dependencies: {p0: '*'}}}};

    for (let index = 0; index < 102; index++) {
        lock.packages[`node_modules/p${index}`] = {
            version: '1.0.0',
            dependencies: index < 101 ? {[`p${index + 1}`]: '*'} : {},
        };
    }

    assert.throws(() => builder.runtimeVersions(lock, new Set()), /depth exceeds the proof limit/);
});

test('candidate allowlist supports all or explicit unique targets and excludes direct CLI updates', () => {
    assert.deepEqual(planner.allowlist('cut-extension, utils'), ['cut-extension', 'utils']);
    assert.deepEqual(planner.allowlist('all'), ['all']);
    assert.deepEqual(planner.allowlist('a,b,c,d'), ['a', 'b', 'c', 'd']);
    for (const value of ['', 'cli', 'utils,utils', '../utils', '*', 'all,utils']) {
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

test('exact PR selection rejects ambiguous inputs before making requests', async () => {
    const request = async () => assert.fail('Invalid selection must not access the API');

    for (const number of ['-1', '1.5', 'NaN', '9007199254740992']) {
        await assert.rejects(
            planner.planTrain(
                {DEPENDENCY_TRAIN_REPOSITORIES: 'utils', DEPENDENCY_TRAIN_PR_NUMBER: number},
                request,
            ),
            /Invalid source PR number/,
        );
    }

    await assert.rejects(
        planner.planTrain(
            {DEPENDENCY_TRAIN_REPOSITORIES: 'utils,transform', DEPENDENCY_TRAIN_PR_NUMBER: '160'},
            request,
        ),
        /An exact PR requires one repository/,
    );
});

test('publisher refuses preparation without explicit run approval', async () => {
    await assert.rejects(
        publisher.publish(fixturePlan(), 'must-not-be-read', {GITHUB_SHA: SHA}, async () =>
            assert.fail('Unapproved publication must not access the API'),
        ),
        /Preparation is not approved/,
    );
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
    const before = {name: '@diplodoc/utils', dependencies: {'@types/example': '^1.0.0'}};
    const after = {...before, dependencies: {'@types/example': '^1.1.0'}};
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
    const before = {name: '@diplodoc/utils', dependencies: {'@types/example': '^1.0.0'}};
    const after = {...before, dependencies: {'@types/example': '^1.1.0'}};
    const files = [{filename: 'package-lock.json', status: 'modified'}];
    const run = (pr, changed, manifest, targetLock = lock(manifest, '1.1.0')) =>
        planner.assess(pr, changed, before, manifest, lock(before), targetLock, []);
    assert.throws(() => run({...fixturePr(), user: {login: 'someone'}}, files, after));
    assert.throws(() => run(fixturePr(), files, {...after, scripts: {prepare: 'bad'}}));
    assert.throws(() => run(fixturePr(), [{filename: '.github/workflows/x.yml'}], after));
    assert.throws(() => run(fixturePr(), files, after, lock(before)));
    const major = {...after, dependencies: {'@types/example': '^2.0.0'}};
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
        builder.verifyLockedTree(
            directory,
            directory,
            lock({dependencies: {parser: '*'}}, '1.1.0'),
            new Set(),
        ),
    );
    assert.equal(
        builder.verifyLockedTree(
            directory,
            directory,
            lock({dependencies: {parser: '*'}}),
            new Set(),
        ).length,
        1,
    );
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
    const registry = (item) => ({
        ...item.manifest,
        resolved: `https://registry.npmjs.org/${item.manifest.name}/-/${item.repo}-1.0.0.tgz`,
        integrity: `sha512-${require('node:crypto').createHash('sha512').update(item.repo).digest('base64')}`,
    });
    const baseline = {lockfileVersion: 3, packages: {'': plan.cli.manifest}};
    const candidate = {lockfileVersion: 3, packages: {'': manifest}};
    const locks = new Map();

    for (const item of order) {
        baseline.packages[`node_modules/${item.manifest.name}`] = registry(item);
        candidate.packages[`node_modules/${item.manifest.name}`] = {
            ...item.manifest,
            resolved: `file:dependency-train/payload/${item.repo}.tgz`,
            integrity: registry(item).integrity,
        };
        locks.set(item.repo, {
            lockfileVersion: 3,
            packages: {
                '': item.manifest,
                ...(item.repo === 'transform'
                    ? {'node_modules/@diplodoc/utils': registry(order[0])}
                    : {}),
            },
        });
    }
    common.write(path.join(directory, 'package-lock.json'), candidate);
    const packages = order.map((item) => {
        const bytes = Buffer.from(item.repo);
        fs.writeFileSync(path.join(directory, `dependency-train/payload/${item.repo}.tgz`), bytes);
        return {
            repo: item.repo,
            name: item.manifest.name,
            sourceSha: item.sha,
            archiveSha256: common.digest(bytes),
            sourceLockSha256: common.digest(JSON.stringify(locks.get(item.repo))),
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
    const validate = () => publisher.validatePayload(plan, directory, locks, baseline);

    assert.equal(validate().length, 5);
    common.write(path.join(directory, 'package.json'), {...manifest, scripts: {prepare: 'bad'}});
    assert.throws(validate);
    common.write(path.join(directory, 'package.json'), manifest);
    fs.writeFileSync(path.join(directory, 'extra.js'), 'bad');
    assert.throws(validate);
    fs.unlinkSync(path.join(directory, 'extra.js'));
    if (process.platform !== 'win32') {
        fs.symlinkSync(path.join(directory, 'package.json'), path.join(directory, 'unexpected'));
        assert.throws(validate);
    }
});

test('manual preparation does not require enabling scheduled execution', () => {
    const workflow = yaml.load(
        fs.readFileSync(
            path.join(root, '.github/workflows/dependency-candidate-train.yml'),
            'utf8',
        ),
    );

    assert.equal(workflow.on.workflow_dispatch.inputs.dry_run.default, true);
    assert.equal(workflow.on.workflow_dispatch.inputs.pr_number.default, 0);
    assert.equal(workflow.on.workflow_dispatch.inputs.wave.default, 1);
    assert.deepEqual(Object.keys(workflow.jobs), ['select', 'build', 'publish']);

    for (const enabled of ['', 'false', 'true']) {
        const vars = {DEPENDENCY_CANDIDATE_TRAIN_ENABLED: enabled};

        assert.equal(
            runInNewContext(workflow.jobs.select.if, {github: {event_name: 'schedule'}, vars}),
            enabled === 'true',
        );

        for (const dryRun of ['', true, false]) {
            const actual = runInNewContext(workflow.jobs.build.if, {
                needs: {select: {outputs: {selected: '1', 'preparation-available': 'true'}}},
                vars,
                github: {event_name: 'workflow_dispatch'},
                inputs: {dry_run: dryRun},
                toJSON: JSON.stringify,
            });

            assert.equal(actual, dryRun === false);
        }

        for (const available of ['', 'false']) {
            const actual = runInNewContext(workflow.jobs.build.if, {
                needs: {select: {outputs: {selected: '1', 'preparation-available': available}}},
                vars,
                github: {event_name: 'workflow_dispatch'},
                inputs: {dry_run: false},
                toJSON: JSON.stringify,
            });

            assert.equal(actual, false, 'An open or unknown candidate must block a build');
        }
    }
});

test('manual wave zero is rejected by the planner rather than defaulted by the workflow', () => {
    const workflow = yaml.load(
        fs.readFileSync(
            path.join(root, '.github/workflows/dependency-candidate-train.yml'),
            'utf8',
        ),
    );
    const expression = workflow.jobs.select.steps
        .find((step) => step.id === 'plan')
        .env.DEPENDENCY_TRAIN_WAVE.slice(3, -2)
        .trim();

    for (const wave of [0, 1, 2]) {
        assert.equal(
            runInNewContext(expression, {
                github: {event_name: 'workflow_dispatch'},
                inputs: {wave},
                toJSON: JSON.stringify,
            }),
            String(wave),
        );
    }
    assert.equal(
        runInNewContext(expression, {
            github: {event_name: 'schedule'},
            inputs: {},
            toJSON: JSON.stringify,
        }),
        '1',
    );
});

test('GitHub preparation cannot access internal APIs or notification credentials', () => {
    const source = fs.readFileSync(
        path.join(root, '.github/workflows/dependency-candidate-train.yml'),
        'utf8',
    );
    const workflow = yaml.load(source);

    assert.ok(!JSON.stringify(workflow.jobs.build).includes('secrets.'));
    assert.ok(!JSON.stringify(workflow.jobs.select).includes('secrets.'));
    assert.doesNotMatch(
        source,
        /TRAIN_(?:CI|REVIEW|MESSENGER|CA)|OBSERVER_RUNNER|preflight|observe\.js|notify\.js/,
    );

    for (const job of Object.values(workflow.jobs)) {
        const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'));

        assert.equal(checkout.with.ref, '${{ github.sha }}');
        assert.equal(checkout.with['persist-credentials'], false);
    }

    assert.equal(
        workflow.jobs.publish.steps.find((step) => step.id === 'app').with.repositories,
        'cli',
    );

    for (const filename of fs.readdirSync(path.join(root, 'scripts/candidate-train'))) {
        const code = fs.readFileSync(path.join(root, 'scripts/candidate-train', filename), 'utf8');

        assert.doesNotMatch(
            code,
            /\/merges|\/start_ci_checks|StartAction|distribute-infra|npm.*publish|yandex-team|mssngr|TRAIN_(?:CI|REVIEW|MESSENGER)_TOKEN/,
        );
    }
});

test('candidate body is a public handoff and does not certify internal results', () => {
    const body = publisher.candidateBody(
        fixturePlan(),
        'https://github.com/diplodoc-platform/infra/actions/runs/1',
    );

    assert.match(body, /NOT successful document verification/);
    assert.match(body, /exact PR\/SHA and tooling SHA/);
    assert.doesNotMatch(body, /yandex-team|mssngr/);
});

module.exports = {tests};
