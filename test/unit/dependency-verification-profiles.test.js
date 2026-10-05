const assert = require('node:assert');
const yaml = require('js-yaml');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {
    DEFAULT_PROFILE_BY_RISK,
    DEEP_PROFILES,
    SUPPORTED_PROFILES,
} = require('../../scripts/dependency-verification-profiles');
const {verificationDecision} = require('../../scripts/dependency-verification-decision');
const classifier = require('../../scripts/dependency-policy-review');

const tests = [];
const test = (name, fn) => tests.push({name, fn});
const SHA = 'a'.repeat(40);

function assessment(profile) {
    return {
        headSha: SHA,
        hasDependencyChanges: true,
        summary: {total: 1},
        direct: [{}],
        transitive: [],
        maxRisk: 'low',
        verificationProfile: profile,
    };
}

test('classifier and decision share every default and registry verification profile', () => {
    assert.strictEqual(classifier.DEFAULT_PROFILE_BY_RISK, DEFAULT_PROFILE_BY_RISK);
    const registry = yaml.load(
        readFileSync(join(__dirname, '../../dependency-policy.yml'), 'utf8'),
    );
    const profiles = [
        ...Object.values(DEFAULT_PROFILE_BY_RISK),
        ...registry.entries.map((entry) => entry['verification-profile']),
    ];
    for (const profile of profiles) {
        assert.ok(SUPPORTED_PROFILES.includes(profile), profile);
        assert.doesNotThrow(() => verificationDecision(assessment(profile), SHA));
    }
});

test('only the three corpus profiles invoke deep verification', () => {
    assert.deepStrictEqual(DEEP_PROFILES, [
        'document-transform',
        'document-rendering',
        'ecosystem',
    ]);
    for (const profile of SUPPORTED_PROFILES) {
        const {outputs} = verificationDecision(assessment(profile), SHA);
        assert.ok(outputs.includes(`run-deep=${DEEP_PROFILES.includes(profile)}\n`), profile);
    }
});

test('even a deep profile cannot invoke testpack without dependency changes', () => {
    for (const profile of DEEP_PROFILES) {
        const value = {
            ...assessment(profile),
            summary: {total: 0},
            direct: [],
            hasDependencyChanges: false,
        };
        assert.ok(verificationDecision(value, SHA).outputs.includes('run-deep=false\n'));
    }
});

test('profile typos and output injection still fail closed', () => {
    for (const profile of [
        'unknown',
        'standard\nrun-deep=true',
        'toolchain\nrisk=low',
        'ecosystem ',
    ]) {
        assert.throws(
            () => verificationDecision(assessment(profile), SHA),
            /Invalid or inconsistent/,
        );
    }
});

module.exports = {tests};
