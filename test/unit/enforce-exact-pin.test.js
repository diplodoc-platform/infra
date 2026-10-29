const assert = require('node:assert');
const {join} = require('node:path');
const {execSync} = require('node:child_process');
const {createTempDir, removeTempDir} = require('../helpers/temp-dir');
const {writeFile, readFile, writeJson} = require('../helpers/file-utils');
const yaml = require('js-yaml');

const {
    isExactPin,
    extractExactPins,
    findRegistryEntry,
    missingMandatoryFields,
    enforce,
    enforceChanges,
    formatViolations,
} = require('../../scripts/enforce-exact-pin');

const tests = [];
function test(name, fn) {
    tests.push({name, fn});
}

// --- isExactPin ----------------------------------------------------------

test('isExactPin: bare numeric versions are exact pins', () => {
    assert.strictEqual(isExactPin('3.3.2'), true);
    assert.strictEqual(isExactPin('1.0.0'), true);
    assert.strictEqual(isExactPin('1.2.3-beta.1'), true);
    assert.strictEqual(isExactPin('0.0.0'), true);
    assert.strictEqual(isExactPin('1.2.3-beta.1+build.2'), true);
    assert.strictEqual(isExactPin('0.0.0-rc-codex-tabs-pilot-37463553402'), true);
});

test('isExactPin: npm partial, wildcard, hyphen and comparator ranges are not pins', () => {
    for (const version of ['15', '3.3', '1.2.*', '1.2.x', '1.2.3 - 2.0.0', '1.2.3 <2.0.0']) {
        assert.strictEqual(isExactPin(version), false, version);
    }
    for (const version of ['1.2.3garbage', '1.2.3.4', '1.2.3-01', '01.2.3']) {
        assert.strictEqual(isExactPin(version), false, version);
    }
});

test('isExactPin: caret and tilde ranges are not exact pins', () => {
    assert.strictEqual(isExactPin('^3.3.2'), false);
    assert.strictEqual(isExactPin('~3.3.2'), false);
    assert.strictEqual(isExactPin('^1.0.0'), false);
});

test('isExactPin: comparators are not exact pins', () => {
    assert.strictEqual(isExactPin('>3.3.2'), false);
    assert.strictEqual(isExactPin('<3.3.2'), false);
    assert.strictEqual(isExactPin('>=3.3.2'), false);
    assert.strictEqual(isExactPin('<=3.3.2'), false);
    assert.strictEqual(isExactPin('=3.3.2'), false);
});

test('isExactPin: wildcards are not exact pins', () => {
    assert.strictEqual(isExactPin('*'), false);
    assert.strictEqual(isExactPin('x'), false);
    assert.strictEqual(isExactPin('X'), false);
    assert.strictEqual(isExactPin('3.x'), false);
});

test('isExactPin: aliases and protocols are not exact pins', () => {
    assert.strictEqual(isExactPin('workspace:*'), false);
    assert.strictEqual(isExactPin('workspace:^'), false);
    assert.strictEqual(isExactPin('file:../foo'), false);
    assert.strictEqual(isExactPin('link:../foo'), false);
    assert.strictEqual(isExactPin('git+https://github.com/foo/bar.git'), false);
    assert.strictEqual(isExactPin('github:foo/bar'), false);
    assert.strictEqual(isExactPin('npm:foo@1.2.3'), false);
    assert.strictEqual(isExactPin('http://example.com/foo.tgz'), false);
});

test('isExactPin: latest tag is not an exact pin', () => {
    assert.strictEqual(isExactPin('latest'), false);
});

test('isExactPin: ranges with || are not exact pins', () => {
    assert.strictEqual(isExactPin('1.2.3 || 1.3.0'), false);
});

test('isExactPin: handles invalid input', () => {
    assert.strictEqual(isExactPin(''), false);
    assert.strictEqual(isExactPin(null), false);
    assert.strictEqual(isExactPin(undefined), false);
    assert.strictEqual(isExactPin(123), false);
});

test('isExactPin: trims whitespace before checking', () => {
    assert.strictEqual(isExactPin('  3.3.2  '), true);
    assert.strictEqual(isExactPin('  ^3.3.2  '), false);
});

// --- extractExactPins ----------------------------------------------------

test('extractExactPins: collects exact pins from all dependency sections', () => {
    const pkg = {
        dependencies: {svgo: '3.3.2', lodash: '^4.17.0'},
        devDependencies: {eslint: '8.57.0', prettier: '^3.3.3'},
        peerDependencies: {typescript: '5.4.0'},
        optionalDependencies: {fsevents: '^2.3.0'},
    };
    const pins = extractExactPins(pkg);
    const names = pins.map((p) => p.name).sort();
    assert.deepStrictEqual(names, ['eslint', 'svgo', 'typescript']);
});

test('extractExactPins: records section and version', () => {
    const pkg = {dependencies: {svgo: '3.3.2'}};
    const pins = extractExactPins(pkg);
    assert.strictEqual(pins.length, 1);
    assert.strictEqual(pins[0].name, 'svgo');
    assert.strictEqual(pins[0].version, '3.3.2');
    assert.strictEqual(pins[0].section, 'dependencies');
});

test('extractExactPins: returns empty array for object without deps', () => {
    assert.deepStrictEqual(extractExactPins({name: 'foo'}), []);
});

test('extractExactPins: handles null/undefined input', () => {
    assert.deepStrictEqual(extractExactPins(null), []);
    assert.deepStrictEqual(extractExactPins(undefined), []);
});

test('extractExactPins: ignores missing/empty sections', () => {
    const pkg = {dependencies: {}, devDependencies: null, peerDependencies: undefined};
    assert.deepStrictEqual(extractExactPins(pkg), []);
});

// --- findRegistryEntry ---------------------------------------------------

test('findRegistryEntry: matches by dependency name and allowed-version', () => {
    const entries = [
        {
            id: 'DEP-0001',
            dependency: 'svgo',
            'allowed-version': '3.3.2',
            'expires-at': '2099-01-01',
        },
        {
            id: 'DEP-0002',
            dependency: 'ajv',
            'allowed-version': '8.17.1',
            'expires-at': '2099-01-01',
        },
    ];
    const entry = findRegistryEntry(entries, 'svgo', '3.3.2');
    assert.ok(entry);
    assert.strictEqual(entry.id, 'DEP-0001');
});

test('findRegistryEntry: matches when allowed-version is missing (covers any pin)', () => {
    const entries = [{id: 'DEP-0001', dependency: 'svgo', 'expires-at': '2099-01-01'}];
    const entry = findRegistryEntry(entries, 'svgo', '3.3.2');
    assert.ok(entry);
});

test('findRegistryEntry: returns undefined when version does not match', () => {
    const entries = [{id: 'DEP-0001', dependency: 'svgo', 'allowed-version': '3.3.2'}];
    assert.strictEqual(findRegistryEntry(entries, 'svgo', '3.3.3'), undefined);
});

test('findRegistryEntry: returns undefined when dependency name not in registry', () => {
    const entries = [{id: 'DEP-0001', dependency: 'svgo', 'allowed-version': '3.3.2'}];
    assert.strictEqual(findRegistryEntry(entries, 'lodash', '4.17.0'), undefined);
});

test('findRegistryEntry: coerces numeric allowed-version to string', () => {
    const entries = [
        {id: 'DEP-0001', dependency: 'svgo', 'allowed-version': 3.3, 'expires-at': '2099-01-01'},
    ];
    const entry = findRegistryEntry(entries, 'svgo', '3.3');
    assert.ok(entry);
});

test('findRegistryEntry: handles non-array entries', () => {
    assert.strictEqual(findRegistryEntry(null, 'svgo', '3.3.2'), undefined);
    assert.strictEqual(findRegistryEntry(undefined, 'svgo', '3.3.2'), undefined);
});

test('findRegistryEntry: ordinary exceptions expire and missing or invalid dates fail closed', () => {
    const entry = {dependency: 'svgo', 'allowed-version': '3.3.2'};
    const now = new Date('2026-10-06T00:00:00Z');
    const match = (expiry) =>
        findRegistryEntry(
            [{...entry, 'expires-at': expiry}],
            'svgo',
            '3.3.2',
            undefined,
            undefined,
            now,
        );

    for (const expiry of [
        undefined,
        null,
        '',
        false,
        1,
        'invalid',
        '2026-02-30',
        '2026-10-05',
        '2026-10-06',
        new Date('invalid'),
    ]) {
        assert.strictEqual(match(expiry), undefined, String(expiry));
    }
    for (const expiry of ['2026-10-07', new Date('2026-10-07')]) {
        assert.ok(match(expiry));
    }
});

// --- missingMandatoryFields ----------------------------------------------

test('managed infra policy allows scoped dev release pins but fails closed elsewhere', () => {
    const entry = {
        dependency: '@diplodoc/infra',
        'pin-policy': 'managed-infra',
        repositories: ['tabs-extension'],
        'expires-at': '2026-12-01',
        reason: 'distribution release identity',
        owner: 'team',
    };
    const now = new Date('2026-10-06');
    const match = (overrides, name, version, section, repo, date = now) =>
        findRegistryEntry([{...entry, ...overrides}], name, version, section, repo, date);
    for (const version of ['2.2.3', '0.0.0-rc-codex-tabs-pilot-37463553402']) {
        assert.deepStrictEqual(
            match({}, '@diplodoc/infra', version, 'devDependencies', 'tabs-extension'),
            entry,
        );
    }
    for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies', undefined]) {
        assert.strictEqual(
            match({}, '@diplodoc/infra', '2.2.3', section, 'tabs-extension'),
            undefined,
        );
    }
    for (const version of ['2', '2.2.3-malicious', '2.2.3+metadata', '2.2.3 || 3.0.0']) {
        assert.strictEqual(
            match({}, '@diplodoc/infra', version, 'devDependencies', 'tabs-extension'),
            undefined,
        );
    }
    for (const overrides of [
        {'expires-at': null},
        {'expires-at': 'invalid'},
        {'expires-at': undefined},
        {'expires-at': '2026-02-30'},
        {repositories: []},
        {dependency: 'other'},
    ]) {
        assert.strictEqual(
            match(overrides, '@diplodoc/infra', '2.2.3', 'devDependencies', 'tabs-extension'),
            undefined,
        );
    }
    assert.strictEqual(
        match({}, '@diplodoc/infra', '2.2.3', 'devDependencies', 'unknown'),
        undefined,
    );
    assert.strictEqual(
        match({}, '@diplodoc/infra', '2.2.3', 'devDependencies', undefined),
        undefined,
    );
    assert.strictEqual(
        match(
            {},
            '@diplodoc/infra',
            '2.2.3',
            'devDependencies',
            'tabs-extension',
            new Date('2026-12-01'),
        ),
        undefined,
    );
});

test('real registry accepts the pilot infra pin without permitting runtime or unrelated pins', () => {
    const registry = yaml.load(readFile(join(__dirname, '../..'), 'dependency-policy.yml'));
    const version = '0.0.0-rc-codex-tabs-infra-pilot-20261006-37463553402';
    assert.strictEqual(
        enforceChanges(
            {devDependencies: {'@diplodoc/infra': '2.2.3'}},
            {devDependencies: {'@diplodoc/infra': version}},
            registry,
            'tabs-extension',
        ).ok,
        true,
    );
    for (const pkg of [
        {dependencies: {'@diplodoc/infra': version}},
        {devDependencies: {typescript: '6.0.4'}},
    ])
        assert.strictEqual(enforceChanges({}, pkg, registry, 'tabs-extension').ok, false);
});

test('real registry accepts only the reviewed Transform inline and extension pins', () => {
    const registry = yaml.load(readFile(join(__dirname, '../..'), 'dependency-policy.yml'));
    const {filterEntriesForRepo} = require('../../scripts/generate-dependency-policy');
    const pins = {
        'markdown-it-ins': '4.0.0',
        'markdown-it-sub': '2.0.0',
        '@diplodoc/directive': '0.5.0-transform5.2',
        '@diplodoc/tabs-extension': '3.10.8-transform5.2',
        '@diplodoc/cut-extension': '1.1.9-transform5.1',
    };
    const result = enforceChanges({}, {dependencies: pins}, registry, 'transform');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.checked, 5);
    assert.strictEqual(registry.entries.length, 23);
    for (const [name, version] of Object.entries(pins)) {
        const entry = findRegistryEntry(
            filterEntriesForRepo(registry.entries, 'transform'),
            name,
            version,
        );
        assert.deepStrictEqual(entry.repositories, ['transform']);
        assert.strictEqual(entry.risk, 'critical');
        assert.strictEqual(entry['verification-profile'], 'ecosystem');
        assert.deepStrictEqual(entry['ignored-versions'], []);
        assert.ok(entry['review-after']);
        assert.ok(entry['expires-at']);
    }
});

test('real registry rejects different inline and directive versions', () => {
    const registry = yaml.load(readFile(join(__dirname, '../..'), 'dependency-policy.yml'));
    const result = enforceChanges(
        {},
        {
            dependencies: {
                'markdown-it-ins': '4.0.1',
                'markdown-it-sub': '2.0.1',
                '@diplodoc/directive': '0.5.0-transform5.3',
            },
        },
        registry,
        'transform',
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.checked, 3);
    assert.deepStrictEqual(result.violations.map(({name}) => name).sort(), [
        '@diplodoc/directive',
        'markdown-it-ins',
        'markdown-it-sub',
    ]);
});

test('real registry rejects the reviewed Transform pins in CLI scope', () => {
    const registry = yaml.load(readFile(join(__dirname, '../..'), 'dependency-policy.yml'));
    const result = enforceChanges(
        {},
        {
            dependencies: {
                'markdown-it-ins': '4.0.0',
                'markdown-it-sub': '2.0.0',
                '@diplodoc/directive': '0.5.0-transform5.2',
            },
        },
        registry,
        'cli',
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.checked, 3);
    assert.strictEqual(result.violations.length, 3);
});

test('new exact pins retain version, repository and expiry boundaries', () => {
    const registry = yaml.load(readFile(join(__dirname, '../..'), 'dependency-policy.yml'));
    const pins = [
        ['@typescript-eslint/eslint-plugin', '8.72.1', 'notes-extension'],
        ['@typescript-eslint/parser', '8.72.1', 'notes-extension'],
        ['markdown-it', '15.0.3', 'notes-extension'],
        ['typescript', '6.0.3', 'notes-extension'],
        ['esbuild', '0.25.12', 'notes-extension'],
        ['sass', '1.97.3', 'notes-extension'],
        ['markdown-it-directive', '2.0.6', 'directive'],
        ['markdown-it-footnote', '4.0.0', 'transform'],
        ['@mdit/plugin-tasklist', '1.1.4', 'transform'],
        ['@diplodoc/notes-extension', '0.1.0-transform5.0', 'transform'],
        ['@diplodoc/directive', '0.5.0-transform5.2', 'cut-extension'],
        ['@diplodoc/directive', '0.5.0-transform5.2', 'notes-extension'],
        ['@diplodoc/directive', '0.5.0-transform5.2', 'tabs-extension'],
        ['@diplodoc/directive', '0.5.0-transform5.2', 'transform'],
        ['@diplodoc/tabs-extension', '3.10.8-transform5.2', 'transform'],
        ['@diplodoc/cut-extension', '1.1.9-transform5.1', 'transform'],
    ];
    for (const [name, version, repo] of pins) {
        const section = name.startsWith('@diplodoc/') ? 'dependencies' : 'devDependencies';
        const pkg = {[section]: {[name]: version}};
        assert.strictEqual(enforce(pkg, registry, repo).ok, true, `${repo}:${name}`);
        assert.strictEqual(enforce(pkg, registry, 'cli').ok, false, `cli:${name}`);
        assert.strictEqual(
            enforce({[section]: {[name]: '99.0.0'}}, registry, repo).ok,
            false,
            `wrong version ${name}`,
        );
        const entry = registry.entries.find(
            (item) =>
                item.dependency === name &&
                item.repositories.includes(repo) &&
                item['allowed-version'] === version,
        );
        assert.ok(entry, name);
        if (name === '@diplodoc/directive' && repo !== 'transform') {
            assert.strictEqual(entry.id, 'DEP-0022');
            assert.strictEqual(
                enforce({dependencies: {[name]: '0.5.0-transform5.1'}}, registry, repo).ok,
                false,
                'The current registry supersedes the previous adapter prerelease pin',
            );
        }
        assert.strictEqual(
            findRegistryEntry([entry], name, version, section, repo, new Date('2026-11-01')),
            entry,
            `live ${name}`,
        );
        assert.deepStrictEqual(
            entry.repositories,
            name === '@diplodoc/directive' && repo !== 'transform'
                ? ['cut-extension', 'notes-extension', 'tabs-extension']
                : [repo],
        );
        assert.deepStrictEqual(entry['ignored-versions'], []);
        assert.strictEqual(
            new Date(entry['review-after']).toISOString().slice(0, 10),
            '2026-11-17',
        );
        assert.strictEqual(new Date(entry['expires-at']).toISOString().slice(0, 10), '2026-12-01');
        assert.strictEqual(
            findRegistryEntry([entry], name, version, section, repo, new Date('2026-12-01')),
            undefined,
            `expired ${name}`,
        );
    }
});

test('Transform extension pins reject superseded versions and do not duplicate repository scope', () => {
    const registry = yaml.load(readFile(join(__dirname, '../..'), 'dependency-policy.yml'));
    const {filterEntriesForRepo} = require('../../scripts/generate-dependency-policy');
    const entries = filterEntriesForRepo(registry.entries, 'transform');
    for (const [name, versions] of [
        ['@diplodoc/directive', ['0.5.0-transform5.0', '0.5.0-transform5.1']],
        ['@diplodoc/tabs-extension', ['3.10.8-transform5.0', '3.10.8-transform5.1']],
        ['@diplodoc/cut-extension', ['1.1.6', '1.1.9-transform5.0']],
    ]) {
        assert.strictEqual(entries.filter((entry) => entry.dependency === name).length, 1);
        for (const version of versions) {
            assert.strictEqual(
                enforce({dependencies: {[name]: version}}, registry, 'transform').ok,
                false,
                `${name}@${version}`,
            );
        }
    }
});

test('Utils prerelease is restricted to the three reviewed repositories and expires', () => {
    const registry = yaml.load(readFile(join(__dirname, '../..'), 'dependency-policy.yml'));
    const entry = registry.entries.find((item) => item.id === 'DEP-0006');
    assert.deepStrictEqual(entry.repositories, ['transform', 'tabs-extension', 'cut-extension']);
    assert.deepStrictEqual(entry['ignored-versions'], []);
    const pkg = {dependencies: {'@diplodoc/utils': '2.3.7-transform5.0'}};
    for (const repo of entry.repositories)
        assert.strictEqual(enforce(pkg, registry, repo).ok, true, repo);
    assert.strictEqual(enforce(pkg, registry, 'cli').ok, false);
    assert.strictEqual(
        enforce(
            {dependencies: {'@diplodoc/utils': '2.3.7-transform5.1'}},
            registry,
            'cut-extension',
        ).ok,
        false,
    );
    assert.strictEqual(
        findRegistryEntry(
            [entry],
            '@diplodoc/utils',
            '2.3.7-transform5.0',
            'dependencies',
            'cut-extension',
            new Date('2026-12-01'),
        ),
        undefined,
    );
});

test('notes managed infra pin remains dev-only and scope-bound', () => {
    const registry = yaml.load(readFile(join(__dirname, '../..'), 'dependency-policy.yml'));
    const version = '2.3.0';
    assert.strictEqual(
        enforce({devDependencies: {'@diplodoc/infra': version}}, registry, 'notes-extension').ok,
        true,
    );
    assert.strictEqual(
        enforce({peerDependencies: {'@diplodoc/infra': version}}, registry, 'notes-extension').ok,
        false,
    );
    assert.strictEqual(
        enforce({devDependencies: {'@diplodoc/infra': version}}, registry, 'unmanaged').ok,
        false,
    );
    assert.strictEqual(
        enforce(
            {devDependencies: {'@diplodoc/infra': '2.3.0-transform5.0'}},
            registry,
            'notes-extension',
        ).ok,
        false,
    );
});

test('managed infra scope covers distribution and reviewed notes-only preparation', () => {
    const registry = yaml.load(readFile(join(__dirname, '../..'), 'dependency-policy.yml'));
    const distribution = yaml.load(readFile(join(__dirname, '../..'), 'distribution.yml'));
    const managed = registry.entries.find((entry) => entry['pin-policy'] === 'managed-infra');
    assert.deepStrictEqual(
        [...managed.repositories].sort(),
        [...Object.keys(distribution.repos), 'notes-extension'].sort(),
    );
    for (const directory of ['.github', 'scaffolding/.github']) {
        const workflow = yaml.load(
            readFile(
                join(__dirname, '../..', directory, 'workflows'),
                'dependency-policy-check.yml',
            ),
        );
        const step = workflow.jobs['dependency-policy-check'].steps.find(
            (item) => item.name === 'Run exact-pin enforcement',
        );
        assert.strictEqual(step.env.POLICY_REPOSITORY, '${{ github.event.repository.name }}');
        assert.ok(step.run.includes('--repo "$POLICY_REPOSITORY"'));
    }
});

test('missingMandatoryFields: returns empty array when reason and owner present', () => {
    assert.deepStrictEqual(missingMandatoryFields({reason: 'x', owner: 'y'}), []);
});

test('missingMandatoryFields: reports missing reason', () => {
    assert.deepStrictEqual(missingMandatoryFields({owner: 'y'}), ['reason']);
});

test('missingMandatoryFields: reports missing owner', () => {
    assert.deepStrictEqual(missingMandatoryFields({reason: 'x'}), ['owner']);
});

test('missingMandatoryFields: reports both when empty strings', () => {
    assert.deepStrictEqual(missingMandatoryFields({reason: '  ', owner: ''}), ['reason', 'owner']);
});

test('missingMandatoryFields: handles non-object entry', () => {
    assert.deepStrictEqual(missingMandatoryFields(null), ['reason', 'owner']);
});

// --- enforce -------------------------------------------------------------

test('enforce: passes when every exact pin has a registry entry', () => {
    const pkg = {dependencies: {svgo: '3.3.2'}, devDependencies: {lodash: '^4.17.0'}};
    const registry = {
        entries: [
            {
                id: 'DEP-0001',
                dependency: 'svgo',
                'allowed-version': '3.3.2',
                reason: 'broken',
                owner: 'team',
                'expires-at': '2099-01-01',
                repositories: ['cli', 'transform'],
            },
        ],
    };
    const result = enforce(pkg, registry, 'cli');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.checked, 1);
    assert.deepStrictEqual(result.violations, []);
});

test('enforce: flags pin with no matching registry entry', () => {
    const pkg = {dependencies: {svgo: '3.3.2'}};
    const registry = {entries: []};
    const result = enforce(pkg, registry, 'cli');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.violations.length, 1);
    assert.strictEqual(result.violations[0].name, 'svgo');
    assert.ok(result.violations[0].reason.includes('no matching registry entry'));
});

test('enforceChanges: permits unchanged legacy exact pins', () => {
    const before = {devDependencies: {typescript: '6.0.3'}};
    const after = {devDependencies: {typescript: '6.0.3'}};
    const result = enforceChanges(before, after, {entries: []}, 'testpack');

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.checked, 0);
    assert.strictEqual(result.existing, 1);
});

test('enforceChanges: rejects a newly introduced unregistered pin', () => {
    const before = {devDependencies: {typescript: '^6.0.0'}};
    const after = {devDependencies: {typescript: '6.0.3'}};
    const result = enforceChanges(before, after, {entries: []}, 'testpack');

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.checked, 1);
    assert.strictEqual(result.existing, 0);
    assert.strictEqual(result.violations[0].name, 'typescript');
});

test('enforceChanges: validates a changed exact version against the registry', () => {
    const before = {dependencies: {svgo: '3.3.1'}};
    const after = {dependencies: {svgo: '3.3.2'}};
    const registry = {
        entries: [
            {
                id: 'DEP-0001',
                dependency: 'svgo',
                'allowed-version': '3.3.2',
                reason: 'Known rendering regression in newer versions',
                owner: 'team',
                'expires-at': '2099-01-01',
                repositories: ['cli'],
            },
        ],
    };
    const result = enforceChanges(before, after, registry, 'cli');

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.checked, 1);
});

test('enforce: flags entry missing mandatory reason/owner', () => {
    const pkg = {dependencies: {svgo: '3.3.2'}};
    const registry = {
        entries: [
            {
                id: 'DEP-0001',
                dependency: 'svgo',
                'allowed-version': '3.3.2',
                'expires-at': '2099-01-01',
            },
        ],
    };
    const result = enforce(pkg, registry, 'cli');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.violations.length, 1);
    assert.ok(result.violations[0].reason.includes('mandatory fields'));
});

test('enforce: scopes entries by repo when repoName given', () => {
    const pkg = {dependencies: {svgo: '3.3.2'}};
    const registry = {
        entries: [
            {
                id: 'DEP-0001',
                dependency: 'svgo',
                'allowed-version': '3.3.2',
                reason: 'x',
                owner: 'y',
                repositories: ['transform'],
                'expires-at': '2099-01-01',
            },
        ],
    };
    // cli is not in the repositories list -> entry does not apply -> violation
    const result = enforce(pkg, registry, 'cli');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.violations.length, 1);
});

test('enforce: global entries (no repositories) apply to all repos', () => {
    const pkg = {dependencies: {svgo: '3.3.2'}};
    const registry = {
        entries: [
            {
                id: 'DEP-0001',
                dependency: 'svgo',
                'allowed-version': '3.3.2',
                reason: 'x',
                owner: 'y',
                'expires-at': '2099-01-01',
            },
        ],
    };
    const result = enforce(pkg, registry, 'cli');
    assert.strictEqual(result.ok, true);
});

test('enforce: counts only exact pins, ignores ranges', () => {
    const pkg = {
        dependencies: {
            svgo: '3.3.2',
            lodash: '^4.17.0',
            ajv: '~8.17.1',
            wildcard: '1.2.*',
            partial: '15',
            hyphen: '1.2.3 - 2.0.0',
            comparators: '1.2.3 <2.0.0',
        },
    };
    const registry = {
        entries: [
            {
                id: 'DEP-0001',
                dependency: 'svgo',
                'allowed-version': '3.3.2',
                reason: 'x',
                owner: 'y',
                'expires-at': '2099-01-01',
            },
        ],
    };
    const result = enforce(pkg, registry, 'cli');
    assert.strictEqual(result.checked, 1);
    assert.strictEqual(result.ok, true);
});

test('enforce: handles missing registry entries key', () => {
    const pkg = {dependencies: {svgo: '3.3.2'}};
    const result = enforce(pkg, {}, 'cli');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.violations.length, 1);
});

test('enforce: no exact pins -> ok with zero checked', () => {
    const pkg = {dependencies: {lodash: '^4.17.0'}};
    const result = enforce(pkg, {entries: []}, 'cli');
    assert.strictEqual(result.checked, 0);
    assert.strictEqual(result.ok, true);
});

// --- formatViolations ----------------------------------------------------

test('formatViolations: produces readable multi-line message', () => {
    const violations = [
        {
            name: 'svgo',
            version: '3.3.2',
            section: 'dependencies',
            reason: 'no matching registry entry',
        },
    ];
    const msg = formatViolations(violations);
    assert.ok(msg.includes('svgo'));
    assert.ok(msg.includes('3.3.2'));
    assert.ok(msg.includes('dependencies'));
    assert.ok(msg.includes('dependency-policy.yml'));
});

test('formatViolations: returns empty string for no violations', () => {
    assert.strictEqual(formatViolations([]), '');
    assert.strictEqual(formatViolations(null), '');
});

// --- CLI integration -----------------------------------------------------

const SCRIPT = join(__dirname, '../../scripts/enforce-exact-pin.js');
const REAL_REGISTRY = join(__dirname, '../../dependency-policy.yml');

test('CLI: passes for transform package.json against real registry', async () => {
    const tempDir = await createTempDir();
    try {
        writeJson(tempDir, 'package.json', {
            name: '@diplodoc/transform',
            version: '1.0.0',
            devDependencies: {svgo: '4.1.0'},
        });
        execSync(
            `node "${SCRIPT}" --registry "${REAL_REGISTRY}" --package "${join(tempDir, 'package.json')}" --repo transform`,
            {stdio: 'pipe', env: {...process.env}},
        );
    } finally {
        await removeTempDir(tempDir);
    }
});

test('CLI: fails for unregistered exact pin', async () => {
    const tempDir = await createTempDir();
    try {
        writeJson(tempDir, 'package.json', {
            name: '@diplodoc/transform',
            version: '1.0.0',
            dependencies: {'some-unknown-dep': '1.2.3'},
        });
        let failed = false;
        let stderr = '';
        try {
            execSync(
                `node "${SCRIPT}" --registry "${REAL_REGISTRY}" --package "${join(tempDir, 'package.json')}" --repo transform`,
                {stdio: 'pipe', env: {...process.env}},
            );
        } catch (error) {
            failed = true;
            stderr = error.stderr ? error.stderr.toString() : '';
        }
        assert.ok(failed, 'Should exit non-zero');
        assert.ok(stderr.includes('some-unknown-dep'), 'Error should reference the missing dep');
    } finally {
        await removeTempDir(tempDir);
    }
});

test('CLI: exits 0 when there are no exact pins', async () => {
    const tempDir = await createTempDir();
    try {
        writeJson(tempDir, 'package.json', {
            name: '@diplodoc/utils',
            version: '1.0.0',
            dependencies: {lodash: '^4.17.0'},
        });
        execSync(
            `node "${SCRIPT}" --registry "${REAL_REGISTRY}" --package "${join(tempDir, 'package.json')}" --repo utils`,
            {stdio: 'pipe', env: {...process.env}},
        );
    } finally {
        await removeTempDir(tempDir);
    }
});

test('CLI: derives repo name from package.json when --repo omitted', async () => {
    const tempDir = await createTempDir();
    try {
        writeJson(tempDir, 'package.json', {
            name: '@diplodoc/transform',
            version: '1.0.0',
            devDependencies: {svgo: '4.1.0'},
        });
        execSync(
            `node "${SCRIPT}" --registry "${REAL_REGISTRY}" --package "${join(tempDir, 'package.json')}"`,
            {stdio: 'pipe', env: {...process.env}},
        );
    } finally {
        await removeTempDir(tempDir);
    }
});

test('CLI: exits non-zero when package.json is missing', async () => {
    const tempDir = await createTempDir();
    try {
        let failed = false;
        try {
            execSync(
                `node "${SCRIPT}" --registry "${REAL_REGISTRY}" --package "${join(tempDir, 'nope.json')}"`,
                {stdio: 'pipe', env: {...process.env}},
            );
        } catch {
            failed = true;
        }
        assert.ok(failed);
    } finally {
        await removeTempDir(tempDir);
    }
});

module.exports = {tests};
