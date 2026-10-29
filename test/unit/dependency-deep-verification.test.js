const assert = require('node:assert');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const yaml = require('js-yaml');
const {configureDeepVerification} = require('../../scripts/consolidate-dependency-workflows');

const tests = [];
function test(name, fn) {
    tests.push({name, fn});
}

const WORKFLOW_PATH = join(
    __dirname,
    '../../scaffolding/.github/workflows/dependency-risk-assessment.yml',
);
const workflowSource = readFileSync(WORKFLOW_PATH, 'utf8');
const workflow = yaml.load(workflowSource);
const distribution = yaml.load(readFileSync(join(__dirname, '../../distribution.yml'), 'utf8'));
const workflowRelativePath = '.github/workflows/dependency-deep-verification.yml';

test('classifies the actual dependency diff before invoking testpack', () => {
    const classify = workflow.jobs['dependency-risk-assessment'];
    assert.ok(classify);
    assert.strictEqual(workflow.jobs['classify-dependency-diff'], undefined);
    assert.strictEqual(
        (workflowSource.match(/scripts\/dependency-policy-review\.js/g) || []).length,
        1,
    );
    assert.strictEqual(classify.outputs['run-deep'], '${{ steps.decision.outputs.run-deep }}');
    assert.ok(workflowSource.includes('--before-pkg /tmp/before-pkg.json'));
    assert.ok(workflowSource.includes('--after-lock /tmp/after-lock.json'));
    assert.ok(workflowSource.includes('--json artifacts/dependency-risk/assessment.json'));
});

test('does not select deep verification from the repository name', () => {
    const deep = workflow.jobs['deep-verification'];
    assert.strictEqual(
        deep.if,
        "github.event.pull_request.user.login == 'dependabot[bot]' && needs.dependency-risk-assessment.outputs.run-deep == 'true'",
    );
    assert.ok(!workflowSource.includes('["cli","components","transform"]'));
});

test('only Dependabot PR authors can start the automatic deep-verification caller', () => {
    assert.strictEqual(
        workflow.jobs['dependency-risk-assessment'].steps.find((step) => step.id === 'decision').if,
        "github.event.pull_request.user.login == 'dependabot[bot]'",
    );
    // Check the PR author, not the actor: a human may rerun a Dependabot PR.
    assert.ok(!workflowSource.includes('github.actor'));
    assert.strictEqual(workflow.jobs['dependency-risk-assessment'].if, undefined);
    assert.strictEqual(workflow.jobs['deep-verification'].needs, 'dependency-risk-assessment');
    assert.deepStrictEqual(workflow.jobs['deep-verification'].permissions, {contents: 'read'});
    assert.strictEqual(workflow.on.workflow_dispatch, undefined);
    assert.deepStrictEqual(workflow.on.pull_request.paths, ['package.json', 'package-lock.json']);
});

test('passes the repository exact SHA and selected profile to testpack', () => {
    const deep = workflow.jobs['deep-verification'];
    assert.strictEqual(
        deep.uses,
        'diplodoc-platform/testpack/.github/workflows/downstream-check.yml@master',
    );
    assert.strictEqual(deep.with.package, '${{ github.event.repository.name }}');
    assert.strictEqual(deep.with['pr-sha'], '${{ github.event.pull_request.head.sha }}');
    assert.strictEqual(
        deep.with.profile,
        '${{ needs.dependency-risk-assessment.outputs.profile }}',
    );
});

test('distributes deep verification only where the candidate reaches the test graph', () => {
    const excluded = Object.entries(distribution.repos)
        .filter(([, config]) =>
            (config.exclude || []).some((entry) =>
                typeof entry === 'string'
                    ? entry === workflowRelativePath
                    : entry.path === workflowRelativePath,
            ),
        )
        .map(([name]) => name)
        .sort();

    assert.deepStrictEqual(excluded, [
        'algolia-extension',
        'html-extension',
        'package-template',
        'testpack',
        'vsc',
    ]);

    for (const [name, config] of Object.entries(distribution.repos)) {
        const blacklist = (config.exclude || []).map((entry) =>
            typeof entry === 'string' ? entry : entry.path,
        );
        const configured = yaml.load(
            configureDeepVerification(
                workflowSource,
                '.github/workflows/dependency-risk-assessment.yml',
                blacklist,
            ),
        );
        assert.strictEqual(
            Boolean(configured.jobs['deep-verification']),
            !excluded.includes(name),
            name,
        );
        assert.ok(configured.jobs['dependency-risk-assessment']);
    }

    const recipients = Object.keys(distribution.repos)
        .filter((name) => !excluded.includes(name))
        .sort();
    assert.deepStrictEqual(recipients, [
        'ajv',
        'cli',
        'client',
        'color-extension',
        'components',
        'cut-extension',
        'directive',
        'file-extension',
        'folding-headings-extension',
        'latex-extension',
        'liquid',
        'mermaid-extension',
        'openapi-extension',
        'page-constructor-extension',
        'quote-link-extension',
        'search-extension',
        'sentenizer',
        'tabs-extension',
        'transform',
        'translation',
        'utils',
        'yfmlint',
    ]);
});

test('combined workflow preserves assessment artifacts, publisher binding and trusted exporter', () => {
    const steps = workflow.jobs['dependency-risk-assessment'].steps;
    const decision = steps.find((step) => step.id === 'decision');
    assert.strictEqual(
        decision.run,
        'node trusted-infra/scripts/dependency-verification-decision.js artifacts/dependency-risk/assessment.json',
    );
    assert.strictEqual(decision.env.EXPECTED_SHA, '${{ github.event.pull_request.head.sha }}');
    const assess = steps.find((step) => step.name === 'Run dependency risk assessment');
    assert.ok(assess.run.includes('--repo "${{ github.event.repository.name }}"'));
    assert.ok(assess.run.includes('--pr ${{ github.event.pull_request.number }}'));
    assert.ok(assess.run.includes('artifacts/dependency-risk/metadata.json'));
    const upload = steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
    assert.strictEqual(upload.with.name, 'dependency-risk-${{ github.event.pull_request.number }}');
    assert.strictEqual(upload.if, 'always()');
});

module.exports = {tests};
