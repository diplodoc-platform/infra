const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const yaml = require('js-yaml');
const {readBlacklist, isExcluded} = require('../../scripts/scaffolding-blacklist');

const tests = [];
const test = (name, fn) => tests.push({name, fn});
const root = path.join(__dirname, '../..');
const files = ['.github/dependabot.yml', '.github/dependency-policy.yml'];
const patterns = {
    directory: ['.github/'],
    glob: ['.github/*.yml'],
    exact: files,
};

test('shared scaffolding matcher handles directory boundaries, globs and Windows paths', () => {
    assert.equal(isExcluded('.github/dependabot.yml', ['.github']), true);
    assert.equal(isExcluded('.github/dependabot.yml', ['.github/']), true);
    assert.equal(isExcluded('.github\\dependabot.yml', ['.github/*.yml']), true);
    assert.equal(isExcluded('.github/workflows/check.yml', ['.github/work*']), true);
    assert.equal(isExcluded('.github/dependabot.yml.backup', ['.github/dependabot.yml']), false);
    assert.equal(isExcluded('.github-extra/file', ['.github']), false);
    assert.equal(isExcluded('.github/workflows/check.yml', ['.github/*.yml']), false);
    assert.deepEqual(readBlacklist({INFRA_BLACKLIST: 'broken'}), []);
    assert.deepEqual(readBlacklist({INFRA_BLACKLIST: '{}'}), []);
});

function workspace(run) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-blacklist-sync-'));
    try {
        const target = path.join(directory, 'target');
        fs.mkdirSync(target);
        fs.writeFileSync(
            path.join(target, 'package.json'),
            JSON.stringify({name: 'test-pkg', version: '1.0.0'}),
        );
        run({directory, target});
    } finally {
        fs.rmSync(directory, {recursive: true, force: true});
    }
}

function sync({directory, target}, central = [], local = []) {
    const config = path.join(directory, 'distribution.yml');
    fs.writeFileSync(config, yaml.dump({repos: {'test-pkg': {exclude: central}}}));
    fs.writeFileSync(path.join(target, '.infrarc.yml'), yaml.dump({exclude: local}));
    execFileSync(
        process.execPath,
        [
            path.join(root, 'bin/infra.js'),
            'sync',
            '--target',
            target,
            '--repo',
            'test-pkg',
            '--config',
            config,
        ],
        {cwd: root, encoding: 'utf8', stdio: 'pipe'},
    );
}

test('isolated infra sync generates unexcluded policy and Dependabot files', () => {
    workspace((context) => {
        sync(context);
        const policy = yaml.load(fs.readFileSync(path.join(context.target, files[1]), 'utf8'));
        assert.equal(policy['generated-for'], 'test-pkg');
        const dependabot = fs.readFileSync(path.join(context.target, files[0]), 'utf8');
        assert.ok(!dependabot.includes('# @generated-ignore'));
        assert.ok(dependabot.includes('no registry-based ignores'));
    });
});

for (const [kind, exclusions] of Object.entries(patterns)) {
    for (const origin of ['central', 'local']) {
        for (const existing of [false, true]) {
            test(`isolated sync preserves ${origin} ${kind} exclusions (${existing ? 'custom files' : 'missing files'})`, () => {
                workspace((context) => {
                    const custom = 'custom content, intentionally not valid YAML: [\n';
                    if (existing) {
                        fs.mkdirSync(path.join(context.target, '.github'));
                        for (const file of files)
                            fs.writeFileSync(path.join(context.target, file), custom);
                    }
                    sync(
                        context,
                        origin === 'central' ? exclusions : [],
                        origin === 'local' ? exclusions : [],
                    );
                    for (const file of files) {
                        const target = path.join(context.target, file);
                        if (existing) assert.equal(fs.readFileSync(target, 'utf8'), custom);
                        else assert.equal(fs.existsSync(target), false, file);
                    }
                });
            });
        }
    }
}

test('direct generators skip excluded missing files before reading unrelated inputs', () => {
    workspace(({directory}) => {
        for (const [file, script] of [
            [files[0], 'generate-dependabot-ignores.js'],
            [files[1], 'generate-dependency-policy.js'],
        ]) {
            const output = execFileSync(
                process.execPath,
                [
                    path.join(root, 'scripts', script),
                    '--registry',
                    path.join(directory, 'missing-registry'),
                ],
                {
                    cwd: directory,
                    env: {...process.env, INFRA_BLACKLIST: JSON.stringify([file])},
                    encoding: 'utf8',
                    stdio: 'pipe',
                },
            );
            assert.ok(output.includes('blacklisted'));
            assert.equal(fs.existsSync(path.join(directory, file)), false);
        }
    });
});

test('unexcluded missing Dependabot input remains an error', () => {
    workspace(({directory}) => {
        assert.throws(
            () =>
                execFileSync(
                    process.execPath,
                    [
                        path.join(root, 'scripts/generate-dependabot-ignores.js'),
                        '--repo',
                        'test-pkg',
                    ],
                    {
                        cwd: directory,
                        encoding: 'utf8',
                        stdio: 'pipe',
                        env: {...process.env, INFRA_BLACKLIST: '[]'},
                    },
                ),
            /dependabot.yml not found/,
        );
    });
});

test('root and distributed policy jobs stay identical; only consumers have the optional deep caller', () => {
    for (const file of [
        'dependency-policy-check.yml',
        'dependency-review.yml',
        'dependency-risk-assessment.yml',
        'dependency-risk-comment.yml',
    ]) {
        if (file === 'dependency-risk-assessment.yml') {
            const distributed = yaml.load(
                fs.readFileSync(path.join(root, 'scaffolding/.github/workflows', file), 'utf8'),
            );
            delete distributed.jobs['deep-verification'];
            assert.deepEqual(
                yaml.load(fs.readFileSync(path.join(root, '.github/workflows', file), 'utf8')),
                distributed,
            );
            continue;
        }
        assert.deepEqual(
            fs.readFileSync(path.join(root, '.github/workflows', file)),
            fs.readFileSync(path.join(root, 'scaffolding/.github/workflows', file)),
            file,
        );
    }
});

const legacyWorkflow = '.github/workflows/dependency-deep-verification.yml';
const assessmentWorkflow = '.github/workflows/dependency-risk-assessment.yml';
const legacyTemplate = fs.readFileSync(
    path.join(root, 'test/fixtures/workflows/dependency-deep-verification-v2.3.0.yml'),
    'utf8',
);

function installLegacy(target) {
    fs.mkdirSync(path.join(target, '.github/workflows'), {recursive: true});
    fs.writeFileSync(path.join(target, legacyWorkflow), legacyTemplate);
}

test('sync replaces the stock deep workflow with a single combined assessment workflow idempotently', () => {
    workspace((context) => {
        installLegacy(context.target);
        sync(context);
        assert.equal(fs.existsSync(path.join(context.target, legacyWorkflow)), false);
        const file = path.join(context.target, assessmentWorkflow);
        const first = fs.readFileSync(file, 'utf8');
        const workflow = yaml.load(first);
        assert.deepEqual(Object.keys(workflow.jobs), [
            'dependency-risk-assessment',
            'deep-verification',
        ]);
        assert.ok(!workflow.jobs['classify-dependency-diff']);
        sync(context);
        assert.equal(fs.readFileSync(file, 'utf8'), first);
    });
});

for (const origin of ['central', 'local']) {
    test(`sync preserves ${origin} deep opt-outs while retaining risk assessment`, () => {
        workspace((context) => {
            installLegacy(context.target);
            sync(
                context,
                origin === 'central' ? [legacyWorkflow] : [],
                origin === 'local' ? [legacyWorkflow] : [],
            );
            assert.equal(
                fs.readFileSync(path.join(context.target, legacyWorkflow), 'utf8'),
                legacyTemplate,
            );
            const workflow = yaml.load(
                fs.readFileSync(path.join(context.target, assessmentWorkflow), 'utf8'),
            );
            assert.ok(workflow.jobs['dependency-risk-assessment']);
            assert.equal(workflow.jobs['deep-verification'], undefined);
        });
    });
}

test('excluding the replacement preserves the legacy workflow instead of silently removing verification', () => {
    workspace((context) => {
        installLegacy(context.target);
        sync(context, [assessmentWorkflow]);
        assert.equal(
            fs.readFileSync(path.join(context.target, legacyWorkflow), 'utf8'),
            legacyTemplate,
        );
        assert.equal(fs.existsSync(path.join(context.target, assessmentWorkflow)), false);
    });
});

test('custom legacy workflows are preserved during sync', () => {
    workspace((context) => {
        installLegacy(context.target);
        const custom = legacyTemplate + '\n# Custom integration\n';
        fs.writeFileSync(path.join(context.target, legacyWorkflow), custom);
        sync(context);
        assert.equal(fs.readFileSync(path.join(context.target, legacyWorkflow), 'utf8'), custom);
    });
});

test('migration accepts the stock CRLF template but preserves symlinks and missing replacements', () => {
    const {removeLegacyDeepWorkflow} = require('../../scripts/consolidate-dependency-workflows');
    workspace(({target}) => {
        installLegacy(target);
        removeLegacyDeepWorkflow(target, []);
        assert.equal(fs.existsSync(path.join(target, legacyWorkflow)), true);

        const link = path.join(target, legacyWorkflow);
        const externalDir = path.join(target, 'external');
        fs.mkdirSync(externalDir);
        const external = path.join(externalDir, 'workflow.yml');
        fs.writeFileSync(external, legacyTemplate);
        fs.unlinkSync(link);
        fs.symlinkSync(externalDir, link, process.platform === 'win32' ? 'junction' : 'dir');
        fs.writeFileSync(path.join(target, assessmentWorkflow), 'replacement');
        removeLegacyDeepWorkflow(target, []);
        assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
        assert.equal(fs.readFileSync(external, 'utf8'), legacyTemplate);

        fs.rmSync(link, {recursive: true, force: true});
        assert.equal(fs.readFileSync(external, 'utf8'), legacyTemplate);
        fs.writeFileSync(link, legacyTemplate.replace(/\n/g, '\r\n'));
        removeLegacyDeepWorkflow(target, []);
        assert.equal(fs.existsSync(link), false);
    });
});

module.exports = {tests};
