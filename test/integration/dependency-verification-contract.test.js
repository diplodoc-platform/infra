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
                options.repo || 'transform',
                '--head-sha',
                SHA,
                '--pr',
                '42',
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
        'markdown-it-container',
        '3.0.0',
        '3.0.1',
        'dependencies',
        'high',
        'document-transform',
        true,
    ],
    [
        'bundled dev anchor generator patch',
        'slugify',
        '1.6.6',
        '1.6.9',
        'devDependencies',
        'high',
        'document-transform',
        true,
    ],
    [
        'production anchor generator patch',
        'slugify',
        '1.6.6',
        '1.6.9',
        'dependencies',
        'high',
        'document-transform',
        true,
    ],
    [
        'dev anchor generator major',
        'github-slugger',
        '1.0.0',
        '2.0.0',
        'devDependencies',
        'critical',
        'ecosystem',
        true,
    ],
    [
        'critical parser major',
        'markdown-it-container',
        '3.0.0',
        '4.0.0',
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
        beforeLock: lockfile(pkg, {'node_modules/markdown-it-container': {version: '3.0.0'}}),
        afterLock: lockfile(pkg, {'node_modules/markdown-it-container': {version: '3.0.1'}}),
    });
    assert.strictEqual(assessment.summary.direct, 0);
    assert.strictEqual(assessment.summary.transitive, 1);
    assert.strictEqual(outputs.profile, 'document-transform');
    assert.strictEqual(outputs['run-deep'], 'true');
});

test('lock-only dev anchor update requires deep verification despite an unchanged manifest', () => {
    const pkg = manifest('slugify', '^1.6.6', 'devDependencies');
    const beforeLock = lockfile(pkg);
    const afterLock = lockfile(pkg);
    beforeLock.packages['node_modules/slugify'].version = '1.6.6';
    afterLock.packages['node_modules/slugify'].version = '1.6.9';
    const {assessment, outputs} = classifyAndDecide(pkg, pkg, {beforeLock, afterLock});
    assert.strictEqual(assessment.summary.direct, 0);
    assert.strictEqual(assessment.summary.transitive, 1);
    assert.strictEqual(outputs.risk, 'high');
    assert.strictEqual(outputs.profile, 'document-transform');
    assert.strictEqual(outputs['run-deep'], 'true');
});

test('grouping anchor and test-tool patches does not hide output-affecting risk', () => {
    const before = manifest('slugify', '1.6.6', 'devDependencies');
    before.devDependencies.vitest = '4.1.6';
    const after = manifest('slugify', '1.6.9', 'devDependencies');
    after.devDependencies.vitest = '4.1.7';
    const {assessment, outputs} = classifyAndDecide(before, after);
    assert.strictEqual(assessment.summary.direct, 2);
    assert.strictEqual(outputs.risk, 'high');
    assert.strictEqual(outputs.profile, 'document-transform');
    assert.strictEqual(outputs['run-deep'], 'true');
});

test('components lock-only DOMPurify update selects real browser coverage', () => {
    const pkg = manifest('isomorphic-dompurify', '^2.20.0');
    pkg.name = '@diplodoc/components';
    const {assessment, outputs} = classifyAndDecide(pkg, pkg, {
        repo: 'components',
        beforeLock: lockfile(pkg, {'node_modules/dompurify': {version: '3.3.1'}}),
        afterLock: lockfile(pkg, {'node_modules/dompurify': {version: '3.4.16'}}),
    });
    assert.strictEqual(assessment.summary.direct, 0);
    assert.strictEqual(assessment.summary.transitive, 1);
    assert.strictEqual(outputs.risk, 'high');
    assert.strictEqual(outputs.profile, 'document-rendering');
    assert.strictEqual(outputs['run-deep'], 'true');
});

test('direct DOMPurify patch selects rendering without lowering major-bump coverage', () => {
    for (const [to, risk, profile] of [
        ['3.3.2', 'high', 'document-rendering'],
        ['4.0.0', 'critical', 'ecosystem'],
    ]) {
        const {outputs} = classifyAndDecide(
            manifest('dompurify', '3.3.1'),
            manifest('dompurify', to),
        );
        assert.strictEqual(outputs.risk, risk);
        assert.strictEqual(outputs.profile, profile);
        assert.strictEqual(outputs['run-deep'], 'true');
    }
});

test('grouping DOMPurify with a registry transform profile preserves browser coverage', () => {
    for (const reverse of [false, true]) {
        const dependencies = [
            ['dompurify', '3.3.1'],
            ['@diplodoc/infra', '2.2.2'],
        ];
        if (reverse) dependencies.reverse();
        const before = {
            ...manifest('dompurify', '3.3.1'),
            dependencies: Object.fromEntries(dependencies),
        };
        const after = {
            ...before,
            dependencies: {...before.dependencies, dompurify: '3.4.16', '@diplodoc/infra': '2.2.3'},
        };
        const {outputs} = classifyAndDecide(before, after, {repo: 'components'});
        assert.strictEqual(outputs.risk, 'high');
        assert.strictEqual(outputs.profile, 'document-rendering');
    }
});

test('grouping DOMPurify with critical changes keeps the ecosystem profile', () => {
    const before = manifest('dompurify', '3.3.1');
    before.dependencies['markdown-it'] = '14.1.0';
    const after = {
        ...before,
        dependencies: {...before.dependencies, dompurify: '3.4.16', 'markdown-it': '15.0.0'},
    };
    const {outputs} = classifyAndDecide(before, after);
    assert.strictEqual(outputs.risk, 'critical');
    assert.strictEqual(outputs.profile, 'ecosystem');
});

test('grouped registry entries preserve rendering coverage in either manifest order', () => {
    for (const reverse of [false, true]) {
        const entries = [
            ['@diplodoc/infra', '2.2.2'],
            ['svgo', '4.1.0'],
        ];
        if (reverse) entries.reverse();
        const before = {...manifest('svgo', '4.1.0'), dependencies: Object.fromEntries(entries)};
        const after = {
            ...before,
            dependencies: {...before.dependencies, '@diplodoc/infra': '2.2.3', svgo: '4.1.1'},
        };
        const {outputs} = classifyAndDecide(before, after, {repo: 'transform'});

        assert.strictEqual(outputs.risk, 'high');
        assert.strictEqual(outputs.profile, 'document-rendering');
        assert.strictEqual(outputs['run-deep'], 'true');
    }
});

test('removing DOMPurify does not introduce a new deep-profile trigger', () => {
    const {outputs} = classifyAndDecide(manifest('dompurify', '3.3.1'), {dependencies: {}});
    assert.strictEqual(outputs.risk, 'low');
    assert.strictEqual(outputs.profile, 'standard');
    assert.strictEqual(outputs['run-deep'], 'false');
});

module.exports = {tests};
