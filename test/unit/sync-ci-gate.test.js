const assert = require('node:assert');

const {
    matchesGlob,
    filterChecks,
    resolveGateConfig,
    buildRulesetPayload,
    selectRulesetAction,
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
