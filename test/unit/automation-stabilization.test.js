const assert = require('node:assert');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {runInNewContext} = require('node:vm');
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

test('keeps dependency auto-merge audit-only during stabilization', () => {
    assert.match(workflowSource, /^\s*workflow_dispatch:\s*$/m);
    assert.doesNotMatch(workflowSource, /inputs\.enabled/);
    assert.doesNotMatch(workflowSource, /--enabled/);
    const audit = yaml
        .load(workflowSource)
        .jobs['auto-merge'].steps.find((step) => step.id === 'automerge');
    assert.strictEqual(audit.env.AUTOMERGE_ENABLED, 'false');
    assert.match(audit.run, /--dry-run/);
    const summaryHelper = readFileSync(
        join(__dirname, '../../scripts/workflows/dependency-auto-merge-summary.js'),
        'utf8',
    );
    assert.match(summaryHelper, /DRY-RUN \(audit only\)/);
    assert.match(workflowSource, /publish_issue:[\s\S]*?default:\s*false/);
    const publish = yaml
        .load(workflowSource)
        .jobs['auto-merge'].steps.find((step) => step.name === 'Post audit log as tracking issue');
    assert.strictEqual(
        publish.if,
        "always() && github.event_name == 'workflow_dispatch' && inputs.publish_issue == true",
    );
});

test('keeps dependency health non-mutating by default', () => {
    assert.match(healthWorkflowSource, /^\s*workflow_dispatch:\s*$/m);
    assert.match(healthWorkflowSource, /dry_run:[\s\S]*?default:\s*true/);
    assert.match(
        healthWorkflowSource,
        /if: always\(\) && github\.event_name == 'workflow_dispatch' && toJSON\(inputs\.dry_run\) == 'false'/,
    );
    assert.match(healthWorkflowSource, /DRY_RUN_FLAG="--dry-run"/);
});

test('keeps CI gate synchronization dry-run by default', () => {
    assert.match(syncCiGateWorkflowSource, /^\s*workflow_dispatch:\s*$/m);
    assert.match(syncCiGateWorkflowSource, /dry_run:[\s\S]*?default:\s*true/);
    assert.match(syncCiGateWorkflowSource, /DRY_RUN_FLAG="--dry-run"/);
});

const scheduledAudits = [
    {
        source: healthWorkflowSource,
        job: 'audit',
        variable: 'DEPENDENCY_HEALTH_ENABLED',
        cron: '17 0 * * *',
    },
    {
        source: workflowSource,
        job: 'auto-merge',
        variable: 'DEPENDENCY_AUTOMERGE_AUDIT_ENABLED',
        cron: '47 0 * * *',
    },
    {
        source: syncCiGateWorkflowSource,
        job: 'prepare',
        variable: 'DEPENDENCY_CI_GATE_AUDIT_ENABLED',
        cron: '23 1 * * 1',
    },
];

for (const {source, job, variable, cron} of scheduledAudits) {
    const workflow = yaml.load(source);
    const condition = workflow.jobs[job].if;

    test(`${variable}: gates scheduled work before checkout or token creation`, () => {
        assert.deepStrictEqual(workflow.on.schedule, [{cron}]);
        assert.deepStrictEqual(Object.keys(workflow.on).sort(), ['schedule', 'workflow_dispatch']);
        assert.strictEqual(
            condition.replace(/\s+/g, ' ').trim(),
            "github.event_name == 'workflow_dispatch' || (github.event_name == 'schedule' && " +
                "vars.DEPENDENCY_SCHEDULES_ENABLED == 'true' && " +
                `vars.${variable} == 'true')`,
        );
        assert.ok(workflow.jobs[job]['timeout-minutes'] > 0);
    });

    // These expressions use only the shared JS/Actions boolean subset. Model
    // missing configuration variables as empty strings, as Actions does.
    for (const schedules of ['', 'false', 'true']) {
        for (const capability of ['', 'false', 'true']) {
            test(`${variable}: schedule flags ${schedules || 'unset'}/${capability || 'unset'}`, () => {
                const enabled = runInNewContext(condition, {
                    github: {event_name: 'schedule'},
                    vars: {DEPENDENCY_SCHEDULES_ENABLED: schedules, [variable]: capability},
                });

                assert.strictEqual(enabled, schedules === 'true' && capability === 'true');
            });
        }
    }

    test(`${variable}: preserves manual runs when schedules are disabled`, () => {
        assert.strictEqual(
            runInNewContext(condition, {
                github: {event_name: 'workflow_dispatch'},
                vars: {DEPENDENCY_SCHEDULES_ENABLED: '', [variable]: ''},
            }),
            true,
        );
    });

    test(`${variable}: rejects unrelated events even when both flags are enabled`, () => {
        for (const event of ['push', 'pull_request', 'workflow_call']) {
            assert.strictEqual(
                runInNewContext(condition, {
                    github: {event_name: event},
                    vars: {DEPENDENCY_SCHEDULES_ENABLED: 'true', [variable]: 'true'},
                }),
                false,
            );
        }
    });
}

for (const [name, source, jobName, stepId] of [
    ['health assignments', healthWorkflowSource, 'audit', 'assign'],
    ['CI gate synchronization', syncCiGateWorkflowSource, 'sync', undefined],
]) {
    test(`${name}: scheduled and unspecified inputs cannot disable dry-run`, () => {
        const workflow = yaml.load(source);
        const step = workflow.jobs[jobName].steps.find((entry) =>
            stepId ? entry.id === stepId : entry.env && entry.env.DRY_RUN,
        );
        assert.strictEqual(
            step.env.DRY_RUN,
            "${{ github.event_name != 'workflow_dispatch' || toJSON(inputs.dry_run) != 'false' }}",
        );
        assert.match(step.run, /DRY_RUN_FLAG="--dry-run"/);
        assert.match(step.run, /if \[ "\$\{DRY_RUN\}" = "false" \]; then\s+DRY_RUN_FLAG=""/);

        const expression = step.env.DRY_RUN.slice(3, -2);

        for (const event of ['schedule', 'workflow_dispatch']) {
            for (const dryRun of ['', 'false', true, false]) {
                const inputs = {dry_run: dryRun};
                const result = runInNewContext(expression, {
                    github: {event_name: event},
                    inputs,
                    toJSON: JSON.stringify,
                });

                assert.strictEqual(result, event !== 'workflow_dispatch' || dryRun !== false);
            }
        }
    });
}

test('CI gate matrix and reporting cannot run after a disabled prepare job', () => {
    const workflow = yaml.load(syncCiGateWorkflowSource);
    assert.strictEqual(workflow.jobs.sync.needs, 'prepare');
    assert.strictEqual(
        workflow.jobs.sync.if,
        "needs.prepare.result == 'success' && needs.prepare.outputs.repos != '[]'",
    );
    assert.deepStrictEqual(workflow.jobs.report.needs, ['prepare', 'sync']);
    assert.strictEqual(workflow.jobs.report.if, "always() && needs.prepare.result == 'success'");
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
