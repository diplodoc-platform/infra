const assert = require('node:assert');
const {execFileSync, spawnSync} = require('node:child_process');
const {mkdtempSync, writeFileSync, rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {
    deriveIsGrouped,
    deriveCiCompletedAt,
    deriveChecksGreen,
    deriveHasException,
    buildEvaluationInput,
    classifyPrForAutoMerge,
    formatAuditEntry,
    renderAuditLog,
    summarizeAudit,
    extractRequiredCheckContexts,
    resolveAutoMergeMode,
} = require('../../scripts/auto-merge');

const tests = [];
function test(name, fn) {
    tests.push({name, fn});
}

// --- deriveIsGrouped -------------------------------------------------------

test('deriveIsGrouped: true for grouped label', () => {
    assert.ok(deriveIsGrouped({labels: ['grouped'], title: 'Bump eslint from 7 to 8'}));
});

test('deriveIsGrouped: true for title with " and "', () => {
    assert.ok(deriveIsGrouped({labels: ['dependencies'], title: 'Bump eslint and prettier'}));
});

test('deriveIsGrouped: true for title with "grouped"', () => {
    assert.ok(deriveIsGrouped({labels: ['dependencies'], title: 'Grouped dependency updates'}));
});

test('deriveIsGrouped: true for multiple package.json files', () => {
    const files = [{filename: 'package.json'}, {filename: 'packages/sub/package.json'}];
    assert.ok(
        deriveIsGrouped({labels: [], title: 'Bump foo from 1 to 2', dependency: 'foo'}, files),
    );
});

test('deriveIsGrouped: false for single dep', () => {
    assert.ok(!deriveIsGrouped({labels: [], title: 'Bump eslint from 7 to 8'}));
});

test('deriveIsGrouped: false for null entry', () => {
    assert.ok(!deriveIsGrouped(null));
});

test('deriveIsGrouped: false for empty entry', () => {
    assert.ok(!deriveIsGrouped({}));
});

// --- deriveCiCompletedAt ---------------------------------------------------

test('deriveCiCompletedAt: returns latest completed_at', () => {
    const response = {
        check_runs: [
            {completed_at: '2026-08-23T10:00:00Z'},
            {completed_at: '2026-08-23T11:00:00Z'},
            {completed_at: '2026-08-23T09:00:00Z'},
        ],
    };
    assert.strictEqual(deriveCiCompletedAt(response), '2026-08-23T11:00:00Z');
});

test('deriveCiCompletedAt: returns null when no completed_at', () => {
    const response = {
        check_runs: [{completed_at: null}, {status: 'in_progress'}],
    };
    assert.strictEqual(deriveCiCompletedAt(response), null);
});

test('deriveCiCompletedAt: returns null for empty check_runs', () => {
    assert.strictEqual(deriveCiCompletedAt({check_runs: []}), null);
});

test('deriveCiCompletedAt: returns null for null input', () => {
    assert.strictEqual(deriveCiCompletedAt(null), null);
    assert.strictEqual(deriveCiCompletedAt(undefined), null);
});

test('deriveCiCompletedAt: handles single completed run', () => {
    const response = {check_runs: [{completed_at: '2026-08-23T10:00:00Z'}]};
    assert.strictEqual(deriveCiCompletedAt(response), '2026-08-23T10:00:00Z');
});

// --- deriveChecksGreen -----------------------------------------------------

test('deriveChecksGreen: true when all runs completed + success', () => {
    const response = {
        check_runs: [
            {
                id: 1,
                name: 'lint',
                app: {id: 15368},
                head_sha: 'a'.repeat(40),
                status: 'completed',
                conclusion: 'success',
            },
            {
                id: 2,
                name: 'test',
                app: {id: 15368},
                head_sha: 'a'.repeat(40),
                status: 'completed',
                conclusion: 'success',
            },
        ],
    };
    assert.ok(
        deriveChecksGreen(
            response,
            [
                {context: 'lint', appId: 15368},
                {context: 'test', appId: 15368},
            ],
            'a'.repeat(40),
        ),
    );
});

test('deriveChecksGreen: false when one run failed', () => {
    const response = {
        check_runs: [
            {
                id: 1,
                name: 'lint',
                app: {id: 15368},
                head_sha: 'a'.repeat(40),
                status: 'completed',
                conclusion: 'success',
            },
            {
                id: 2,
                name: 'test',
                app: {id: 15368},
                head_sha: 'a'.repeat(40),
                status: 'completed',
                conclusion: 'failure',
            },
        ],
    };
    assert.ok(
        !deriveChecksGreen(
            response,
            [
                {context: 'lint', appId: 15368},
                {context: 'test', appId: 15368},
            ],
            'a'.repeat(40),
        ),
    );
});

test('deriveChecksGreen: false when one run is pending', () => {
    const response = {
        check_runs: [
            {
                id: 1,
                name: 'lint',
                app: {id: 15368},
                head_sha: 'a'.repeat(40),
                status: 'completed',
                conclusion: 'success',
            },
            {
                id: 2,
                name: 'test',
                app: {id: 15368},
                head_sha: 'a'.repeat(40),
                status: 'in_progress',
                conclusion: null,
            },
        ],
    };
    assert.ok(
        !deriveChecksGreen(
            response,
            [
                {context: 'lint', appId: 15368},
                {context: 'test', appId: 15368},
            ],
            'a'.repeat(40),
        ),
    );
});

test('deriveChecksGreen: rejects neutral required checks', () => {
    const response = {
        check_runs: [
            {
                id: 1,
                name: 'lint',
                app: {id: 15368},
                head_sha: 'a'.repeat(40),
                status: 'completed',
                conclusion: 'neutral',
            },
            {id: 2, name: 'optional', status: 'completed', conclusion: 'failure'},
        ],
    };
    assert.ok(!deriveChecksGreen(response, [{context: 'lint', appId: 15368}], 'a'.repeat(40)));
});

test('deriveChecksGreen: fails closed when required contexts are unknown', () => {
    const response = {
        check_runs: [
            {
                id: 1,
                name: 'lint',
                app: {id: 15368},
                head_sha: 'a'.repeat(40),
                status: 'completed',
                conclusion: 'success',
            },
        ],
    };
    assert.ok(!deriveChecksGreen(response));
});

test('deriveChecksGreen: false for empty check_runs', () => {
    assert.ok(!deriveChecksGreen({check_runs: []}));
});

test('deriveChecksGreen: false for null input', () => {
    assert.ok(!deriveChecksGreen(null));
});

// --- deriveHasException ----------------------------------------------------

test('deriveHasException: true when entry matches dependency', () => {
    const entries = [{dependency: 'svgo', owner: '@team'}];
    assert.ok(deriveHasException('svgo', entries));
});

test('deriveHasException: false when no entry matches', () => {
    const entries = [{dependency: 'svgo', owner: '@team'}];
    assert.ok(!deriveHasException('lodash', entries));
});

test('deriveHasException: false for empty dependency', () => {
    assert.ok(!deriveHasException('', [{dependency: 'svgo'}]));
});

test('deriveHasException: false for empty entries', () => {
    assert.ok(!deriveHasException('svgo', []));
    assert.ok(!deriveHasException('svgo', null));
    assert.ok(!deriveHasException('svgo', undefined));
});

// --- buildEvaluationInput --------------------------------------------------

const HEAD_SHA = 'a'.repeat(40);
const SAMPLE_EVIDENCE = {
    beforePackage: {devDependencies: {eslint: '8.0.0'}},
    afterPackage: {devDependencies: {eslint: '8.0.1'}},
    beforeLock: {
        lockfileVersion: 3,
        packages: {
            '': {devDependencies: {eslint: '8.0.0'}},
            'node_modules/eslint': {version: '8.0.0'},
        },
    },
    afterLock: {
        lockfileVersion: 3,
        packages: {
            '': {devDependencies: {eslint: '8.0.1'}},
            'node_modules/eslint': {version: '8.0.1'},
        },
    },
};

const SAMPLE_ENTRY = {
    headSha: HEAD_SHA,
    repo: 'cli',
    number: 42,
    title: 'Bump eslint from 8.0.0 to 8.0.1',
    url: 'https://github.com/diplodoc-platform/cli/pull/42',
    dependency: 'eslint',
    fromVersion: '8.0.0',
    toVersion: '8.0.1',
    updateType: 'patch',
    risk: 'low',
    security: false,
    labels: ['dependencies', 'patch'],
};

const SAMPLE_PR_FILES = [
    {
        filename: 'package.json',
        patch: '+  "devDependencies": {\n+    "eslint": "8.0.1"\n-    "eslint": "8.0.0"',
    },
    {
        filename: 'package-lock.json',
        patch: '-    "node_modules/eslint": {\n-      "version": "8.0.0"\n+    "node_modules/eslint": {\n+      "version": "8.0.1"',
    },
];

test('buildEvaluationInput: builds correct input from entry + files', () => {
    const input = buildEvaluationInput(SAMPLE_ENTRY, SAMPLE_PR_FILES, {
        checkRuns: {
            check_runs: [
                {
                    id: 1,
                    name: 'test',
                    app: {id: 15368},
                    head_sha: 'a'.repeat(40),
                    status: 'completed',
                    conclusion: 'success',
                    completed_at: '2026-08-22T10:00:00Z',
                },
            ],
        },
        ...SAMPLE_EVIDENCE,
        requiredChecks: [{context: 'test', appId: 15368}],
        scopedEntries: [],
        now: new Date('2026-08-24T10:00:00Z'),
    });
    assert.strictEqual(input.updateType, 'patch');
    assert.strictEqual(input.risk, 'low');
    assert.strictEqual(input.section, 'devDependencies');
    assert.strictEqual(input.hasException, false);
    assert.strictEqual(input.isGrouped, false);
    assert.strictEqual(input.isSecurity, false);
    assert.deepStrictEqual(input.changedFiles, ['package.json', 'package-lock.json']);
    assert.ok(input.checksGreen);
    assert.strictEqual(input.ciCompletedAt, '2026-08-22T10:00:00Z');
});

test('buildEvaluationInput: refuses title-only section without full evidence', () => {
    const input = buildEvaluationInput(
        {...SAMPLE_ENTRY, section: 'devDependencies'},
        SAMPLE_PR_FILES,
        {},
    );
    assert.strictEqual(input.section, null);
});

test('buildEvaluationInput: section null when no patch in files', () => {
    const input = buildEvaluationInput(SAMPLE_ENTRY, [{filename: 'README.md'}], {});
    assert.strictEqual(input.section, null);
});

test('buildEvaluationInput: hasException true with matching registry entry', () => {
    const input = buildEvaluationInput(
        {...SAMPLE_ENTRY, dependency: 'svgo'},
        [{filename: 'package.json', patch: '+  "devDependencies": {'}],
        {scopedEntries: [{dependency: 'svgo', owner: '@team'}]},
    );
    assert.strictEqual(input.hasException, true);
});

test('buildEvaluationInput: truncated patch alone is insufficient', () => {
    const lockPatch =
        '+    "node_modules/new-transitive-1": {\n+    "node_modules/new-transitive-2": {';
    const input = buildEvaluationInput(
        SAMPLE_ENTRY,
        [{filename: 'package-lock.json', patch: lockPatch}],
        {},
    );
    assert.strictEqual(input.newTransitiveDependencies, null);
});

test('buildEvaluationInput: explicit count does not bypass manifest verification', () => {
    const input = buildEvaluationInput(SAMPLE_ENTRY, [{filename: 'package.json'}], {
        newTransitiveCount: 3,
    });
    assert.strictEqual(input.newTransitiveDependencies, null);
});

test('buildEvaluationInput: missing lock data is unknown, not zero', () => {
    const input = buildEvaluationInput(SAMPLE_ENTRY, [{filename: 'package.json'}], {});
    assert.strictEqual(input.newTransitiveDependencies, null);
});

// --- classifyPrForAutoMerge -----------------------------------------------

test('classifyPrForAutoMerge: returns entry + evaluation + input', () => {
    const result = classifyPrForAutoMerge(SAMPLE_ENTRY, SAMPLE_PR_FILES, {
        checkRuns: {
            check_runs: [
                {
                    id: 1,
                    name: 'test',
                    app: {id: 15368},
                    head_sha: 'a'.repeat(40),
                    status: 'completed',
                    conclusion: 'success',
                    completed_at: '2026-08-22T10:00:00Z',
                },
            ],
        },
        ...SAMPLE_EVIDENCE,
        requiredChecks: [{context: 'test', appId: 15368}],
        scopedEntries: [],
        now: new Date('2026-08-24T10:00:00Z'),
    });
    assert.ok(result.entry);
    assert.ok(result.evaluation);
    assert.ok(result.input);
    assert.strictEqual(result.evaluation.allowed, true);
    assert.strictEqual(result.evaluation.conditions.length, 9);
});

test('classifyPrForAutoMerge: excluded PR is not allowed', () => {
    const entry = {...SAMPLE_ENTRY, updateType: 'major', risk: 'high'};
    const result = classifyPrForAutoMerge(entry, SAMPLE_PR_FILES, {
        checkRuns: {
            check_runs: [
                {
                    name: 'test',
                    app: {id: 15368},
                    head_sha: 'a'.repeat(40),
                    status: 'completed',
                    conclusion: 'success',
                    completed_at: '2026-08-22T10:00:00Z',
                },
            ],
        },
        ...SAMPLE_EVIDENCE,
        requiredChecks: [{context: 'test', appId: 15368}],
        scopedEntries: [],
        now: new Date('2026-08-24T10:00:00Z'),
    });
    assert.strictEqual(result.evaluation.allowed, false);
    assert.strictEqual(result.evaluation.excluded, true);
});

// --- formatAuditEntry ------------------------------------------------------

test('formatAuditEntry: produces structured audit entry', () => {
    const classification = classifyPrForAutoMerge(SAMPLE_ENTRY, SAMPLE_PR_FILES, {
        checkRuns: {
            check_runs: [
                {
                    name: 'test',
                    app: {id: 15368},
                    head_sha: 'a'.repeat(40),
                    status: 'completed',
                    conclusion: 'success',
                    completed_at: '2026-08-22T10:00:00Z',
                },
            ],
        },
        ...SAMPLE_EVIDENCE,
        requiredChecks: [{context: 'test', appId: 15368}],
        scopedEntries: [],
        now: new Date('2026-08-24T10:00:00Z'),
    });
    const audit = formatAuditEntry(classification, {merged: true}, '2026-08-24T10:00:00Z');
    assert.strictEqual(audit.repo, 'cli');
    assert.strictEqual(audit.number, 42);
    assert.strictEqual(audit.dependency, 'eslint');
    assert.strictEqual(audit.fromVersion, '8.0.0');
    assert.strictEqual(audit.toVersion, '8.0.1');
    assert.strictEqual(audit.allowed, true);
    assert.strictEqual(audit.merged, true);
    assert.strictEqual(audit.mergeError, null);
    assert.strictEqual(audit.timestamp, '2026-08-24T10:00:00Z');
    assert.deepStrictEqual(audit.exclusions, []);
});

test('formatAuditEntry: records blocked conditions', () => {
    const classification = classifyPrForAutoMerge(
        {...SAMPLE_ENTRY, updateType: 'minor'},
        SAMPLE_PR_FILES,
        {checkRuns: {check_runs: []}, scopedEntries: [], now: new Date('2026-08-24T10:00:00Z')},
    );
    const audit = formatAuditEntry(classification, {});
    assert.strictEqual(audit.allowed, false);
    assert.ok(audit.exclusions.includes('production-dep'));
    assert.ok(audit.blockingReasons.length > 0);
    assert.strictEqual(audit.merged, false);
});

test('formatAuditEntry: records merge error', () => {
    const classification = classifyPrForAutoMerge(SAMPLE_ENTRY, SAMPLE_PR_FILES, {
        checkRuns: {
            check_runs: [
                {status: 'completed', conclusion: 'success', completed_at: '2026-08-22T10:00:00Z'},
            ],
        },
        scopedEntries: [],
        now: new Date('2026-08-24T10:00:00Z'),
    });
    const audit = formatAuditEntry(classification, {merged: false, mergeError: 'Merge conflict'});
    assert.strictEqual(audit.merged, false);
    assert.strictEqual(audit.mergeError, 'Merge conflict');
});

test('formatAuditEntry: records skipped (dry-run)', () => {
    const classification = classifyPrForAutoMerge(SAMPLE_ENTRY, SAMPLE_PR_FILES, {
        checkRuns: {
            check_runs: [
                {status: 'completed', conclusion: 'success', completed_at: '2026-08-22T10:00:00Z'},
            ],
        },
        scopedEntries: [],
        now: new Date('2026-08-24T10:00:00Z'),
    });
    const audit = formatAuditEntry(classification, {skipped: 'dry-run'});
    assert.strictEqual(audit.merged, false);
    assert.strictEqual(audit.skipped, 'dry-run');
});

test('formatAuditEntry: default timestamp when omitted', () => {
    const classification = classifyPrForAutoMerge(SAMPLE_ENTRY, SAMPLE_PR_FILES, {
        checkRuns: {
            check_runs: [
                {status: 'completed', conclusion: 'success', completed_at: '2026-08-22T10:00:00Z'},
            ],
        },
        scopedEntries: [],
        now: new Date('2026-08-24T10:00:00Z'),
    });
    const audit = formatAuditEntry(classification, {});
    assert.ok(typeof audit.timestamp === 'string');
    assert.ok(audit.timestamp.length > 0);
});

// --- summarizeAudit --------------------------------------------------------

test('summarizeAudit: empty array', () => {
    const s = summarizeAudit([]);
    assert.strictEqual(s.totalEvaluated, 0);
    assert.strictEqual(s.allowed, 0);
    assert.strictEqual(s.merged, 0);
});

test('summarizeAudit: counts correctly', () => {
    const entries = [
        {allowed: true, excluded: false, merged: true, mergeError: null, skipped: null},
        {allowed: false, excluded: true, merged: false, mergeError: null, skipped: null},
        {allowed: true, excluded: false, merged: false, mergeError: null, skipped: 'dry-run'},
        {allowed: false, excluded: false, merged: false, mergeError: 'conflict', skipped: null},
    ];
    const s = summarizeAudit(entries);
    assert.strictEqual(s.totalEvaluated, 4);
    assert.strictEqual(s.allowed, 2);
    assert.strictEqual(s.excluded, 1);
    assert.strictEqual(s.merged, 1);
    assert.strictEqual(s.mergeErrors, 1);
    assert.strictEqual(s.skipped, 1);
});

test('summarizeAudit: non-array input', () => {
    const s = summarizeAudit(null);
    assert.strictEqual(s.totalEvaluated, 0);
});

// --- renderAuditLog --------------------------------------------------------

test('renderAuditLog: empty audit produces header', () => {
    const md = renderAuditLog([]);
    assert.ok(md.includes('# Auto-merge Audit Log'));
    assert.ok(md.includes('No Dependabot PRs found'));
});

test('renderAuditLog: includes summary table', () => {
    const entries = [
        {
            repo: 'cli',
            number: 42,
            title: 'Bump eslint',
            url: 'https://github.com/diplodoc-platform/cli/pull/42',
            dependency: 'eslint',
            fromVersion: '8.0.0',
            toVersion: '8.0.1',
            updateType: 'patch',
            risk: 'low',
            security: false,
            allowed: true,
            excluded: false,
            exclusions: [],
            failedConditions: [],
            blockingReasons: [],
            merged: true,
            mergeError: null,
            skipped: null,
            timestamp: '2026-08-24T10:00:00Z',
        },
    ];
    const md = renderAuditLog(entries);
    assert.ok(md.includes('Total evaluated'));
    assert.ok(md.includes('1'));
    assert.ok(md.includes('cli'));
    assert.ok(md.includes('eslint'));
    assert.ok(md.includes('Auto-merged PRs'));
    assert.ok(md.includes('Rollback'));
});

test('renderAuditLog: no merged section when zero merged', () => {
    const entries = [
        {
            repo: 'cli',
            number: 42,
            title: 'Bump eslint',
            url: '',
            dependency: 'eslint',
            fromVersion: '8.0.0',
            toVersion: '8.0.1',
            updateType: 'minor',
            risk: 'medium',
            security: false,
            allowed: false,
            excluded: true,
            exclusions: ['minor-update'],
            failedConditions: [],
            blockingReasons: ['Exclusion: Minor update'],
            merged: false,
            mergeError: null,
            skipped: null,
            timestamp: '2026-08-24T10:00:00Z',
        },
    ];
    const md = renderAuditLog(entries);
    assert.ok(!md.includes('## Auto-merged PRs'));
    assert.ok(md.includes('Exclusion: Minor update'));
});

test('renderAuditLog: escapes pipe characters in title', () => {
    const entries = [
        {
            repo: 'cli',
            number: 42,
            title: 'Bump foo|bar from 1 to 2',
            url: '',
            dependency: 'foo|bar',
            fromVersion: '1',
            toVersion: '2',
            updateType: 'patch',
            risk: 'low',
            security: false,
            allowed: true,
            excluded: false,
            exclusions: [],
            failedConditions: [],
            blockingReasons: [],
            merged: true,
            mergeError: null,
            skipped: null,
            timestamp: '2026-08-24T10:00:00Z',
        },
    ];
    const md = renderAuditLog(entries);
    assert.ok(md.includes('foo\\|bar'));
});

test('renderAuditLog: valid markdown starting with #', () => {
    const md = renderAuditLog([]);
    assert.ok(md.startsWith('# Auto-merge Audit Log'));
});

// --- extractRequiredCheckContexts -----------------------------------------

test('extractRequiredCheckContexts: combines legacy protection and active rulesets', () => {
    const protection = {
        contexts: ['lint'],
        checks: [{context: 'test'}, {context: 'lint'}],
    };
    const rules = [
        {
            type: 'required_status_checks',
            parameters: {
                required_status_checks: [{context: 'build'}, {context: 'test'}],
            },
        },
        {type: 'pull_request', parameters: {}},
    ];

    assert.deepStrictEqual(extractRequiredCheckContexts(protection, rules), [
        {context: 'lint', appId: null},
        {context: 'test', appId: null},
        {context: 'build', appId: null},
    ]);
});

test('extractRequiredCheckContexts: reads organization rules without legacy protection', () => {
    const rules = [
        {
            type: 'required_status_checks',
            ruleset_source_type: 'Organization',
            parameters: {required_status_checks: [{context: 'ci / required'}]},
        },
    ];

    assert.deepStrictEqual(extractRequiredCheckContexts(null, rules), [
        {context: 'ci / required', appId: null},
    ]);
});

test('extractRequiredCheckContexts: fails closed with malformed or absent responses', () => {
    assert.deepStrictEqual(extractRequiredCheckContexts(null, null), []);
    assert.deepStrictEqual(
        extractRequiredCheckContexts({contexts: [null, '']}, [{type: 'required_status_checks'}]),
        [],
    );
});

test('explicit dry-run overrides every live-mode request without requiring observation', () => {
    for (const observed of ['true', 'false', undefined]) {
        assert.strictEqual(
            resolveAutoMergeMode(
                {'dry-run': true, enabled: true, 'skip-checks': true},
                {AUTOMERGE_ENABLED: 'true', AUTOMERGE_OBSERVATION_COMPLETE: observed},
            ),
            false,
        );
    }
    assert.strictEqual(resolveAutoMergeMode({}, {}), false);
});

test('live-mode validation still requires observation and complete checks', () => {
    assert.throws(() => resolveAutoMergeMode({enabled: true}, {}), /OBSERVATION_COMPLETE/);
    assert.throws(
        () =>
            resolveAutoMergeMode(
                {enabled: true, 'skip-checks': true},
                {AUTOMERGE_OBSERVATION_COMPLETE: 'true'},
            ),
        /audit-only/,
    );
    assert.strictEqual(
        resolveAutoMergeMode({enabled: true}, {AUTOMERGE_OBSERVATION_COMPLETE: 'true'}),
        true,
    );
});

test('real CLI keeps explicit dry-run read-only even with live environment flags', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'infra-automerge-dry-run-'));
    try {
        const preload = join(temporary, 'github-mock.cjs');
        writeFileSync(
            preload,
            [
                'global.fetch = async (url, options) => {',
                "    if ((options.method || 'GET') !== 'GET' || !url.includes('/pulls?')) {",
                "        throw new Error('Unexpected or mutating GitHub request');",
                '    }',
                "    return {ok: true, status: 200, text: async () => '[]'};",
                '};',
            ].join('\n'),
        );
        for (const observed of ['true', 'false']) {
            const output = execFileSync(
                process.execPath,
                [
                    '--require',
                    preload,
                    join(__dirname, '../../scripts/auto-merge.js'),
                    '--repo',
                    'fixture',
                    '--dry-run',
                    '--enabled',
                ],
                {
                    env: {
                        ...process.env,
                        GH_TOKEN: 'mock-token',
                        AUTOMERGE_ENABLED: 'true',
                        AUTOMERGE_OBSERVATION_COMPLETE: observed,
                    },
                    encoding: 'utf8',
                },
            );
            assert.deepStrictEqual(JSON.parse(output), []);
        }
    } finally {
        rmSync(temporary, {recursive: true, force: true});
    }
});

test('real auto-merge CLI exits unsuccessfully when inventory cannot be read', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'infra-automerge-incomplete-'));
    try {
        const preload = join(temporary, 'github-mock.cjs');
        writeFileSync(
            preload,
            [
                'global.fetch = async (url, options) => {',
                "    if ((options.method || 'GET') !== 'GET') throw new Error('Mutating request');",
                '    return {ok: false, status: 503, text: async () => \'{"message":"Unavailable"}\'};',
                '};',
            ].join('\n'),
        );
        const result = spawnSync(
            process.execPath,
            [
                '--require',
                preload,
                join(__dirname, '../../scripts/auto-merge.js'),
                '--repo',
                'fixture',
                '--dry-run',
            ],
            {env: {...process.env, GH_TOKEN: 'mock-token'}, encoding: 'utf8'},
        );
        assert.strictEqual(result.status, 1, result.stderr);
        assert.match(result.stderr, /503|Unavailable/);
    } finally {
        rmSync(temporary, {recursive: true, force: true});
    }
});

module.exports = {tests};
