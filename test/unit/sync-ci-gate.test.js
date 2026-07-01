const assert = require('node:assert');

const {
    matchesGlob,
    filterChecks,
    resolveGateConfig,
    buildRulesetPayload,
    selectRulesetAction,
    workflowTriggersPr,
    expandJobContexts,
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

test('resolveGateConfig: per-repo override wins', () => {
    const config = {
        ci_gate: {ruleset_name: 'gate', exclude_checks: ['coverage*']},
        repos: {
            cli: {ci_gate: {exclude_checks: [], required_checks: ['build', 'lint']}},
        },
    };
    const gate = resolveGateConfig(config, 'cli');
    assert.strictEqual(gate.rulesetName, 'gate'); // inherited from base
    assert.deepStrictEqual(gate.excludeChecks, []); // overridden to empty
    assert.deepStrictEqual(gate.requiredChecks, ['build', 'lint']);
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
