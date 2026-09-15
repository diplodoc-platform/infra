const assert = require('node:assert');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const yaml = require('js-yaml');

const tests = [];
function test(name, fn) {
    tests.push({name, fn});
}

const WORKFLOW_PATH = join(
    __dirname,
    '../../scaffolding/.github/workflows/dependency-deep-verification.yml',
);
const workflowSource = readFileSync(WORKFLOW_PATH, 'utf8');
const workflow = yaml.load(workflowSource);
const distribution = yaml.load(readFileSync(join(__dirname, '../../distribution.yml'), 'utf8'));
const workflowRelativePath = '.github/workflows/dependency-deep-verification.yml';

test('classifies the actual dependency diff before invoking testpack', () => {
    const classify = workflow.jobs['classify-dependency-diff'];
    assert.ok(classify);
    assert.strictEqual(classify.outputs['run-deep'], '${{ steps.decision.outputs.run-deep }}');
    assert.ok(workflowSource.includes('--before-pkg /tmp/before-pkg.json'));
    assert.ok(workflowSource.includes('--after-lock /tmp/after-lock.json'));
    assert.ok(
        workflowSource.includes('--json artifacts/dependency-deep-verification/assessment.json'),
    );
});

test('does not select deep verification from the repository name', () => {
    const deep = workflow.jobs['deep-verification'];
    assert.strictEqual(deep.if, "needs.classify-dependency-diff.outputs.run-deep == 'true'");
    assert.ok(!workflowSource.includes('["cli","components","transform"]'));
});

test('passes the repository exact SHA and selected profile to testpack', () => {
    const deep = workflow.jobs['deep-verification'];
    assert.strictEqual(
        deep.uses,
        'diplodoc-platform/testpack/.github/workflows/downstream-check.yml@master',
    );
    assert.strictEqual(deep.with.package, '${{ github.event.repository.name }}');
    assert.strictEqual(deep.with['pr-sha'], '${{ github.event.pull_request.head.sha }}');
    assert.strictEqual(deep.with.profile, '${{ needs.classify-dependency-diff.outputs.profile }}');
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

module.exports = {tests};
