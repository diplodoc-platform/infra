const assert = require('node:assert');

const {
    matchesGlob,
    filterChecks,
    resolveGateConfig,
    resolveProtectionConfig,
    buildRulesetPayload,
    buildProtectionRulesetPayload,
    extractRequiredContextsFromRuleset,
    contextsEqual,
    selectRulesetAction,
    workflowTriggersPr,
    expandJobContexts,
    accumulateWorkflowContexts,
    findContextCollisions,
    contextsFromWorkflowDoc,
    parseRepo,
} = require('../../scripts/sync-ci-gate');

const tests = [];
function test(name, fn) {
    tests.push({name, fn});
}

// --- matchesGlob ----------------------------------------------------------

test('matchesGlob: exact match', () => {
    assert.strictEqual(matchesGlob('Security audit', 'Security audit'), true);
    assert.strictEqual(matchesGlob('Security audit', 'Security'), false);
});

test('matchesGlob: trailing wildcard', () => {
    assert.strictEqual(matchesGlob('coverage', 'coverage*'), true);
    assert.strictEqual(matchesGlob('coverage (report)', 'coverage*'), true);
    assert.strictEqual(matchesGlob('test coverage', 'coverage*'), false);
});

test('matchesGlob: wildcard spans spaces and parentheses', () => {
    assert.strictEqual(matchesGlob('test (ubuntu-latest, 24)', 'test (*)'), true);
});

// --- filterChecks ---------------------------------------------------------

test('filterChecks: drops excluded, dedupes and sorts', () => {
    const result = filterChecks(
        ['test (ubuntu-latest, 24)', 'coverage', 'test (ubuntu-latest, 24)', 'Security audit'],
        ['coverage*'],
    );
    assert.deepStrictEqual(result, ['Security audit', 'test (ubuntu-latest, 24)']);
});

test('filterChecks: trims and ignores empty names', () => {
    const result = filterChecks(['  build  ', '', '   ', 'lint'], []);
    assert.deepStrictEqual(result, ['build', 'lint']);
});

test('filterChecks: no excludes returns all unique', () => {
    const result = filterChecks(['a', 'b', 'a'], []);
    assert.deepStrictEqual(result, ['a', 'b']);
});

// --- resolveGateConfig ----------------------------------------------------

test('resolveGateConfig: defaults when nothing configured', () => {
    const gate = resolveGateConfig({}, 'cli');
    assert.strictEqual(gate.rulesetName, 'master CI gate');
    assert.deepStrictEqual(gate.excludeChecks, []);
    assert.strictEqual(gate.requiredChecks, null);
});

test('resolveGateConfig: global ci_gate is used', () => {
    const config = {
        ci_gate: {ruleset_name: 'gate', exclude_checks: ['coverage*']},
    };
    const gate = resolveGateConfig(config, 'cli');
    assert.strictEqual(gate.rulesetName, 'gate');
    assert.deepStrictEqual(gate.excludeChecks, ['coverage*']);
});

test('resolveGateConfig: per-repo exclude_checks merge onto global', () => {
    const config = {
        ci_gate: {ruleset_name: 'gate', exclude_checks: ['Dependabot*', 'Publish*']},
        repos: {
            components: {ci_gate: {exclude_checks: ['deploy', 'update-screenshots']}},
            cli: {ci_gate: {required_checks: ['build', 'lint']}},
        },
    };
    const components = resolveGateConfig(config, 'components');
    assert.deepStrictEqual(components.excludeChecks, [
        'Dependabot*',
        'Publish*',
        'deploy',
        'update-screenshots',
    ]);

    const cli = resolveGateConfig(config, 'cli');
    assert.deepStrictEqual(cli.excludeChecks, ['Dependabot*', 'Publish*']);
    assert.deepStrictEqual(cli.requiredChecks, ['build', 'lint']);
});

// --- buildRulesetPayload --------------------------------------------------

test('buildRulesetPayload: shape and contexts', () => {
    const payload = buildRulesetPayload({
        rulesetName: 'master CI gate',
        contexts: ['build', 'lint'],
    });
    assert.strictEqual(payload.name, 'master CI gate');
    assert.strictEqual(payload.target, 'branch');
    assert.strictEqual(payload.enforcement, 'active');
    assert.deepStrictEqual(payload.conditions.ref_name.include, ['~DEFAULT_BRANCH']);
    assert.strictEqual(payload.bypass_actors[0].actor_type, 'OrganizationAdmin');

    const rule = payload.rules[0];
    assert.strictEqual(rule.type, 'required_status_checks');
    assert.strictEqual(rule.parameters.strict_required_status_checks_policy, false);
    assert.deepStrictEqual(rule.parameters.required_status_checks, [
        {context: 'build'},
        {context: 'lint'},
    ]);
});

// --- exclude globs (real-world superfluous checks) ------------------------

test('filterChecks: keeps Update package-lock.json, drops Dependabot', () => {
    const parsed = [
        'Dependabot',
        'Security audit',
        'test (ubuntu-latest, 24)',
        'Update package-lock.json',
    ];
    const excludes = ['Dependabot*', 'Publish*', '*coverage*'];
    assert.deepStrictEqual(filterChecks(parsed, excludes), [
        'Security audit',
        'test (ubuntu-latest, 24)',
        'Update package-lock.json',
    ]);
});

test('filterChecks: components-specific excludes', () => {
    const parsed = [
        'Create GitHub Comment',
        'deploy',
        'update-screenshots',
        'Security audit',
        'test (ubuntu-latest, 24)',
    ];
    const excludes = [
        'Dependabot*',
        'Publish*',
        'Create GitHub Comment',
        'deploy',
        'update-screenshots',
    ];
    assert.deepStrictEqual(filterChecks(parsed, excludes), [
        'Security audit',
        'test (ubuntu-latest, 24)',
    ]);
});

test('filterChecks: keeps Test coverage when not excluded', () => {
    const parsed = ['Test coverage', 'Security audit', 'test (ubuntu-latest, 24)'];
    const excludes = ['Dependabot*', 'Publish*', 'SonarCloud*'];
    assert.deepStrictEqual(filterChecks(parsed, excludes), [
        'Security audit',
        'test (ubuntu-latest, 24)',
        'Test coverage',
    ]);
});

test('filterChecks: drops publish, keeps real gates', () => {
    const discovered = [
        'Publish to npm',
        'Security audit',
        'test (macos-latest, 24)',
        'test (ubuntu-latest, 24)',
        'test (windows-latest, 24)',
    ];
    const excludes = ['Publish*'];
    assert.deepStrictEqual(filterChecks(discovered, excludes), [
        'Security audit',
        'test (macos-latest, 24)',
        'test (ubuntu-latest, 24)',
        'test (windows-latest, 24)',
    ]);
});

test('findContextCollisions: flags duplicate context from two workflows', () => {
    const byContext = new Map([
        ['test (ubuntu-latest, 24)', new Set(['tests.yml', 'integration-tests.yml'])],
        ['Security audit', new Set(['security.yml'])],
    ]);
    assert.deepStrictEqual(findContextCollisions(byContext), [
        {
            context: 'test (ubuntu-latest, 24)',
            workflows: ['integration-tests.yml', 'tests.yml'],
        },
    ]);
});

test('accumulateWorkflowContexts: tracks sources per context', () => {
    const map = new Map();
    accumulateWorkflowContexts(map, 'tests.yml', ['test (ubuntu-latest, 24)']);
    accumulateWorkflowContexts(map, 'integration-tests.yml', ['test (ubuntu-latest, 24)']);
    assert.strictEqual(map.get('test (ubuntu-latest, 24)').size, 2);
});

test('filterChecks: drops publish + coverage exclude pattern, keeps real gates', () => {
    const discovered = [
        'Publish to npm',
        'Security audit',
        'test (macos-latest, 24)',
        'test (ubuntu-latest, 24)',
        'test (windows-latest, 24)',
        'Test coverage',
    ];
    const excludes = ['*coverage*', 'coverage*', 'Publish*'];
    assert.deepStrictEqual(filterChecks(discovered, excludes), [
        'Security audit',
        'test (macos-latest, 24)',
        'test (ubuntu-latest, 24)',
        'test (windows-latest, 24)',
    ]);
});

// --- resolveProtectionConfig ----------------------------------------------

test('resolveProtectionConfig: defaults when nothing configured', () => {
    const p = resolveProtectionConfig({}, 'cli');
    assert.strictEqual(p.enabled, true);
    assert.strictEqual(p.rulesetName, 'master protection (auto-merge via app)');
    assert.strictEqual(p.requiredApprovingReviewCount, 1);
    assert.strictEqual(p.requireCodeOwnerReview, true);
    assert.strictEqual(p.dismissStaleReviewsOnPush, false);
    assert.deepStrictEqual(p.allowedMergeMethods, ['rebase', 'squash']);
});

test('resolveProtectionConfig: per-repo override + disable', () => {
    const config = {
        protection_gate: {required_approving_review_count: 1},
        repos: {cli: {protection_gate: {enabled: false, required_approving_review_count: 2}}},
    };
    const p = resolveProtectionConfig(config, 'cli');
    assert.strictEqual(p.enabled, false);
    assert.strictEqual(p.requiredApprovingReviewCount, 2);
});

// --- buildProtectionRulesetPayload ----------------------------------------

test('buildProtectionRulesetPayload: rules + app bypass', () => {
    const payload = buildProtectionRulesetPayload({
        rulesetName: 'master protection (auto-merge via app)',
        requiredApprovingReviewCount: 1,
        requireCodeOwnerReview: true,
        allowedMergeMethods: ['rebase', 'squash'],
        appId: '12345',
    });
    assert.strictEqual(payload.name, 'master protection (auto-merge via app)');
    assert.deepStrictEqual(payload.conditions.ref_name.include, ['~DEFAULT_BRANCH']);

    const types = payload.rules.map((r) => r.type);
    assert.deepStrictEqual(types, ['pull_request', 'deletion', 'non_fast_forward']);

    const pr = payload.rules.find((r) => r.type === 'pull_request');
    assert.strictEqual(pr.parameters.required_approving_review_count, 1);
    assert.strictEqual(pr.parameters.require_code_owner_review, true);
    assert.deepStrictEqual(pr.parameters.allowed_merge_methods, ['rebase', 'squash']);

    const integration = payload.bypass_actors.find((a) => a.actor_type === 'Integration');
    assert.strictEqual(integration.actor_id, 12345);
});

test('buildProtectionRulesetPayload: no app bypass when appId missing', () => {
    const payload = buildProtectionRulesetPayload({
        rulesetName: 'master protection (auto-merge via app)',
    });
    assert.strictEqual(
        payload.bypass_actors.some((a) => a.actor_type === 'Integration'),
        false,
    );
    assert.strictEqual(payload.bypass_actors[0].actor_type, 'OrganizationAdmin');
});

// --- extractRequiredContextsFromRuleset / contextsEqual -------------------

test('extractRequiredContextsFromRuleset: reads required_status_checks rule', () => {
    const ruleset = {
        rules: [
            {
                type: 'required_status_checks',
                parameters: {
                    required_status_checks: [
                        {context: 'test (ubuntu-latest, 24)'},
                        {context: 'Security audit'},
                    ],
                },
            },
        ],
    };
    assert.deepStrictEqual(extractRequiredContextsFromRuleset(ruleset), [
        'Security audit',
        'test (ubuntu-latest, 24)',
    ]);
});

test('contextsEqual: same sorted lists match', () => {
    assert.strictEqual(contextsEqual(['a', 'b'], ['a', 'b']), true);
    assert.strictEqual(contextsEqual(['a'], ['a', 'b']), false);
    assert.strictEqual(contextsEqual(['b', 'a'], ['a', 'b']), false);
});

// --- selectRulesetAction --------------------------------------------------

test('selectRulesetAction: create when absent', () => {
    const action = selectRulesetAction([{id: 1, name: 'other'}], 'master CI gate');
    assert.deepStrictEqual(action, {method: 'POST', id: null});
});

test('selectRulesetAction: update when present (case-insensitive)', () => {
    const action = selectRulesetAction([{id: 7, name: 'Master CI Gate'}], 'master CI gate');
    assert.deepStrictEqual(action, {method: 'PUT', id: 7});
});

// --- workflowTriggersPr ---------------------------------------------------

test('workflowTriggersPr: string / array / object / negative', () => {
    assert.strictEqual(workflowTriggersPr('pull_request'), true);
    assert.strictEqual(workflowTriggersPr(['push', 'pull_request']), true);
    assert.strictEqual(workflowTriggersPr({pull_request: {branches: ['main']}}), true);
    assert.strictEqual(workflowTriggersPr('push'), false);
    assert.strictEqual(workflowTriggersPr({push: {}}), false);
    assert.strictEqual(workflowTriggersPr(undefined), false);
});

// --- expandJobContexts ----------------------------------------------------

test('expandJobContexts: no matrix uses job id', () => {
    assert.deepStrictEqual(expandJobContexts('audit', {name: 'Security audit'}), [
        'Security audit',
    ]);
    assert.deepStrictEqual(expandJobContexts('build', {}), ['build']);
});

test('expandJobContexts: matrix cartesian product (GitHub naming)', () => {
    const job = {
        strategy: {
            matrix: {os: ['ubuntu-latest', 'windows-latest', 'macos-latest'], 'node-version': [24]},
        },
    };
    assert.deepStrictEqual(expandJobContexts('test', job), [
        'test (ubuntu-latest, 24)',
        'test (windows-latest, 24)',
        'test (macos-latest, 24)',
    ]);
});

test('expandJobContexts: oversized matrix falls back to base name (DoS guard)', () => {
    const big = Array.from({length: 20}, (_, i) => `v${i}`);
    const job = {strategy: {matrix: {a: big, b: big, c: big}}};
    // 20*20*20 = 8000 > cap -> no expansion
    assert.deepStrictEqual(expandJobContexts('job', job), ['job']);
});

test('expandJobContexts: name with expression falls back to job id', () => {
    const job = {name: 'build ${{ matrix.os }}', strategy: {matrix: {os: ['a']}}};
    assert.deepStrictEqual(expandJobContexts('build', job), ['build (a)']);
});

// --- contextsFromWorkflowDoc ----------------------------------------------

test('contextsFromWorkflowDoc: PR workflow yields job contexts', () => {
    const doc = {
        on: {pull_request: {branches: ['main']}, push: {branches: ['main']}},
        jobs: {
            test: {strategy: {matrix: {os: ['ubuntu-latest'], 'node-version': [24]}}},
            audit: {name: 'Security audit'},
        },
    };
    assert.deepStrictEqual(contextsFromWorkflowDoc(doc), [
        'test (ubuntu-latest, 24)',
        'Security audit',
    ]);
});

test('contextsFromWorkflowDoc: non-PR workflow yields nothing', () => {
    const doc = {on: {push: {branches: ['main']}}, jobs: {deploy: {}}};
    assert.deepStrictEqual(contextsFromWorkflowDoc(doc), []);
});

test('contextsFromWorkflowDoc: handles YAML 1.1 boolean on-key', () => {
    // js-yaml may parse `on:` as the boolean true.
    const doc = {true: ['pull_request'], jobs: {lint: {}}};
    assert.deepStrictEqual(contextsFromWorkflowDoc(doc), ['lint']);
});

// --- parseRepo ------------------------------------------------------------

test('parseRepo: bare name uses default owner', () => {
    assert.deepStrictEqual(parseRepo('cli'), {owner: 'diplodoc-platform', name: 'cli'});
});

test('parseRepo: owner/name is split', () => {
    assert.deepStrictEqual(parseRepo('acme/cli'), {owner: 'acme', name: 'cli'});
});

test('parseRepo: throws on empty', () => {
    assert.throws(() => parseRepo(''));
});

test('parseRepo: rejects injection-y names', () => {
    assert.throws(() => parseRepo('foo"; rm -rf ~ #'));
    assert.throws(() => parseRepo('owner/..'));
    assert.throws(() => parseRepo('a b/c'));
});

module.exports = {tests};
