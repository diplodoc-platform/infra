const assert = require('node:assert/strict');
const {requireDeepProfile} = require('../../scripts/candidate-train/deep-profile');
const {assertRiskProfile} = require('../../scripts/candidate-train/risk');

const tests = [];
const test = (name, fn) => tests.push({name, fn});
const sha = 'a'.repeat(40);
const item = {repo: 'tabs-extension', number: 170, sha, risk: 'critical', profile: 'ecosystem'};
const prefix = '/repos/diplodoc-platform/tabs-extension/actions/runs/42';
const artifact = `dependency-comparison-42-2-tabs-extension-${sha}-ecosystem`;

function comparisonEvidence({repo, sha, profile}) {
    return {
        check: {
            id: 18,
            name: 'Run Selected Deep Profile / Trusted comparison (never executes package code)',
            app: {id: 15368},
            head_sha: sha,
            check_suite: {id: 12},
            status: 'completed',
            conclusion: 'success',
            details_url: `https://github.com/diplodoc-platform/${repo}/actions/runs/42/job/123`,
        },
        run: {
            id: 42,
            event: 'pull_request',
            head_sha: sha,
            check_suite_id: 12,
            path: '.github/workflows/dependency-risk-assessment.yml',
            run_attempt: 2,
            referenced_workflows: [
                {
                    path: 'diplodoc-platform/testpack/.github/workflows/downstream-check.yml@master',
                    sha,
                },
            ],
        },
        artifact: {
            name: `dependency-comparison-42-2-${repo}-${sha}-${profile}`,
            expired: false,
        },
    };
}

async function verify(e) {
    return requireDeepProfile(item, {check_runs: [e.check]}, async (route) => {
        if (route === prefix) return e.run;
        assert.equal(route, `${prefix}/artifacts?name=${artifact}`);
        return {artifacts: [e.artifact]};
    });
}

test('critical requires a green comparison and artifact for the exact profile and run attempt', async () => {
    await verify(comparisonEvidence(item));
    const cases = [
        (e) => (e.check.conclusion = 'skipped'),
        (e) => (e.check.app.id = 42),
        (e) => (e.check.head_sha = 'b'.repeat(40)),
        (e) => (e.run.check_suite_id = 13),
        (e) => (e.run.path = '.github/workflows/another.yml'),
        (e) => (e.run.referenced_workflows = []),
        (e) => (e.run.run_attempt = 3),
        (e) => (e.artifact.name = artifact.replace('ecosystem', 'document-transform')),
        (e) => (e.artifact.expired = true),
    ];
    for (const change of cases) {
        const e = comparisonEvidence(item);
        change(e);
        await assert.rejects(verify(e), /required ecosystem comparison|\/artifacts\?name=/);
    }
});

test('profile coverage only accepts known and sufficiently strong profiles', () => {
    assertRiskProfile('medium', 'toolchain');
    assertRiskProfile('high', 'document-rendering');
    assertRiskProfile('critical', 'ecosystem');
    assert.throws(() => assertRiskProfile('critical', 'document-rendering'));
    assert.throws(() => assertRiskProfile('unknown', 'ecosystem'));
});

module.exports = {tests, comparisonEvidence};
