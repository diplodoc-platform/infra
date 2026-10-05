const assert = require('node:assert');
const {execFileSync} = require('node:child_process');
const {mkdtempSync, readFileSync, rmSync, writeFileSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');

const tests = [];
const test = (name, fn) => tests.push({name, fn});
const infra = join(__dirname, '../..');
const SHA = 'a'.repeat(40);

function manifest(dependency, version, section = 'dependencies') {
    return {
        name: '@diplodoc/transform',
        version: '1.0.0',
        scripts: {test: 'node test.js'},
        [section]: {[dependency]: version},
    };
}

function lockfile(pkg, extraPackages = {}) {
    const root = {name: pkg.name, version: pkg.version};
    const packages = {'': root, ...extraPackages};
    for (const section of ['dependencies', 'devDependencies']) {
        if (!pkg[section]) continue;
        root[section] = pkg[section];
        for (const [name, version] of Object.entries(pkg[section])) {
            packages[`node_modules/${name}`] = {
                version,
                ...(section === 'devDependencies' ? {dev: true} : {}),
            };
        }
    }
    return {name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true, packages};
}

/** Exercise the real JSON artifact and output-file boundary used by the caller. */
function classifyAndDecide(before, after, options = {}) {
    const root = mkdtempSync(join(tmpdir(), 'dependency-contract-'));
    const file = (name) => join(root, name);
    try {
        const inputs = {
            'before-pkg': before,
            'after-pkg': after,
            'before-lock': options.beforeLock || lockfile(before),
            'after-lock': options.afterLock || lockfile(after),
        };
        const args = [];
        for (const [name, value] of Object.entries(inputs)) {
            writeFileSync(file(`${name}.json`), JSON.stringify(value));
            args.push(`--${name}`, file(`${name}.json`));
        }
        execFileSync(
            process.execPath,
            [
                join(infra, 'scripts/dependency-policy-review.js'),
                ...args,
                '--registry',
                join(infra, 'dependency-policy.yml'),
                '--repo',
                'transform',
                '--head-sha',
                SHA,
                '--compatibility-score',
                '100',
                '--comment',
                file('assessment.md'),
                '--json',
                file('assessment.json'),
                '--quiet',
            ],
            {stdio: 'pipe'},
        );
        const assessment = JSON.parse(readFileSync(file('assessment.json'), 'utf8'));
        execFileSync(
            process.execPath,
            [join(infra, 'scripts/dependency-verification-decision.js'), file('assessment.json')],
            {
                stdio: 'pipe',
                env: {
                    ...process.env,
                    EXPECTED_SHA: SHA,
                    GITHUB_OUTPUT: file('output'),
                    GITHUB_STEP_SUMMARY: file('summary'),
                },
            },
        );
        const outputs = Object.fromEntries(
            readFileSync(file('output'), 'utf8')
                .trim()
                .split('\n')
                .map((line) => line.split('=')),
        );
        assert.ok(readFileSync(file('summary'), 'utf8').includes(assessment.verificationProfile));
        return {assessment, outputs};
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
}

test('unrelated manifest edits successfully export no-change instead of failing', () => {
    const before = manifest('@types/node', '22.0.0', 'devDependencies');
    const after = {...before, scripts: {test: 'node other-test.js'}};
    const {assessment, outputs} = classifyAndDecide(before, after);
    assert.strictEqual(assessment.summary.total, 0);
    assert.deepStrictEqual(outputs, {
        'has-dependency-changes': 'false',
        profile: 'standard',
        risk: 'low',
        'run-deep': 'false',
    });
});

for (const [name, dependency, from, to, section, risk, profile, runDeep] of [
    [
        'dev-only types patch',
        '@types/node',
        '22.0.0',
        '22.0.1',
        'devDependencies',
        'low',
        'standard',
        false,
    ],
    [
        'medium toolchain patch',
        'esbuild',
        '0.25.0',
        '0.25.1',
        'devDependencies',
        'medium',
        'toolchain',
        false,
    ],
    [
        'low production patch',
        'unknown-library',
        '1.0.0',
        '1.0.1',
        'dependencies',
        'low',
        'standard',
        false,
    ],
    [
        'high parser patch',
        'markdown-it',
        '14.1.0',
        '14.1.1',
        'dependencies',
        'high',
        'document-transform',
        true,
    ],
    [
        'critical parser major',
        'markdown-it',
        '14.1.0',
        '15.0.0',
        'dependencies',
        'critical',
        'ecosystem',
        true,
    ],
    [
        'registry rendering override',
        'svgo',
        '3.3.2',
        '3.3.3',
        'dependencies',
        'high',
        'document-rendering',
        true,
    ],
]) {
    test(`${name} exports the classifier's intended profile through the real CLI`, () => {
        const {assessment, outputs} = classifyAndDecide(
            manifest(dependency, from, section),
            manifest(dependency, to, section),
        );
        assert.strictEqual(assessment.summary.total, 1);
        assert.strictEqual(outputs['has-dependency-changes'], 'true');
        assert.strictEqual(outputs.risk, risk);
        assert.strictEqual(outputs.profile, profile);
        assert.strictEqual(outputs['run-deep'], String(runDeep));
    });
}

test('lockfile-only parser update is not mistaken for a no-change PR', () => {
    const pkg = manifest('unknown-library', '1.0.0');
    const {assessment, outputs} = classifyAndDecide(pkg, pkg, {
        beforeLock: lockfile(pkg, {'node_modules/markdown-it': {version: '14.1.0'}}),
        afterLock: lockfile(pkg, {'node_modules/markdown-it': {version: '14.1.1'}}),
    });
    assert.strictEqual(assessment.summary.direct, 0);
    assert.strictEqual(assessment.summary.transitive, 1);
    assert.strictEqual(outputs.profile, 'document-transform');
    assert.strictEqual(outputs['run-deep'], 'true');
});

module.exports = {tests};
