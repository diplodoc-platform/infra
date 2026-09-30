const assert = require('node:assert');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const yaml = require('js-yaml');

const tests = [];
function test(name, fn) {
    tests.push({name, fn});
}

const workflowSource = readFileSync(
    join(__dirname, '../../.github/workflows/dependency-auto-merge.yml'),
    'utf8',
);
const healthWorkflowSource = readFileSync(
    join(__dirname, '../../.github/workflows/dependency-health.yml'),
    'utf8',
);
const syncCiGateWorkflowSource = readFileSync(
    join(__dirname, '../../.github/workflows/sync-ci-gate.yml'),
    'utf8',
);
const distribution = yaml.load(readFileSync(join(__dirname, '../../distribution.yml'), 'utf8'));

test('keeps dependency auto-merge manual during stabilization', () => {
    assert.match(workflowSource, /^\s*workflow_dispatch:\s*$/m);
    assert.doesNotMatch(workflowSource, /^\s*schedule:\s*$/m);
    assert.doesNotMatch(workflowSource, /vars\.AUTOMERGE_ENABLED/);
    assert.doesNotMatch(workflowSource, /inputs\.enabled/);
    assert.doesNotMatch(workflowSource, /--enabled/);
    assert.match(workflowSource, /DRY-RUN \(audit only\)/);
    assert.match(workflowSource, /publish_issue:[\s\S]*?default:\s*false/);
    assert.match(workflowSource, /if: always\(\) && inputs\.publish_issue == true/);
});

test('keeps dependency health manual and non-mutating by default', () => {
    assert.match(healthWorkflowSource, /^\s*workflow_dispatch:\s*$/m);
    assert.doesNotMatch(healthWorkflowSource, /^\s*schedule:\s*$/m);
    assert.match(healthWorkflowSource, /dry_run:[\s\S]*?default:\s*true/);
    assert.match(healthWorkflowSource, /if: always\(\) && inputs\.dry_run == false/);
    assert.match(healthWorkflowSource, /DRY_RUN_FLAG="--dry-run"/);
});

test('keeps CI gate synchronization manual and dry-run by default', () => {
    assert.match(syncCiGateWorkflowSource, /^\s*workflow_dispatch:\s*$/m);
    assert.doesNotMatch(syncCiGateWorkflowSource, /^\s*schedule:\s*$/m);
    assert.match(syncCiGateWorkflowSource, /dry_run:[\s\S]*?default:\s*true/);
    assert.match(syncCiGateWorkflowSource, /DRY_RUN_FLAG="--dry-run"/);
});

test('publishes required audit reports from the hidden status directory', () => {
    const health = yaml.load(healthWorkflowSource);
    const autoMerge = yaml.load(workflowSource);
    const uploads = [...health.jobs.audit.steps, ...autoMerge.jobs['auto-merge'].steps].filter(
        (step) => step.uses && step.uses.startsWith('actions/upload-artifact@'),
    );
    assert.strictEqual(uploads.length, 4);
    for (const step of uploads) {
        assert.match(step.with.path, /^\.status\/dependency-|^\.status\/auto-merge-/);
        assert.strictEqual(step.with['include-hidden-files'], true, step.name);
        assert.strictEqual(step.with['if-no-files-found'], 'error', step.name);
        assert.strictEqual(step.if, 'always()', step.name);
    }
});

test('keeps every distribution target review-only by default', () => {
    assert.strictEqual(distribution.defaults.auto_merge, false);

    for (const [repo, config] of Object.entries(distribution.repos)) {
        assert.notStrictEqual(config.auto_merge, true, `${repo} must not opt into auto-merge`);
    }
});

module.exports = {tests};
