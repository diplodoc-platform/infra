const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const tests = [];
const test = (name, fn) => tests.push({name, fn});
const helpers = {
    'dependency-health.yml': 'dependency-health-summary',
    'dependency-auto-merge.yml': 'dependency-auto-merge-summary',
    'check-pat-expiry.yml': 'pat-expiry-alert',
    'sync-ci-gate.yml': 'ci-gate-report',
    'distribute-infra.yml': 'distribution-report',
};
const run = (name) => require(`../../scripts/workflows/${name}`);
function harness() {
    const output = {summary: '', failures: [], warnings: [], notices: []};
    const core = {
        summary: {
            addRaw: (text) => {
                output.summary += text;
                return core.summary;
            },
            write: async () => {},
        },
        warning: (text) => output.warnings.push(text),
        error: (text) => output.warnings.push(text),
        setFailed: (text) => output.failures.push(text),
        notice: (text) => output.notices.push(text),
    };
    return {
        output,
        clients: {
            core,
            context: {repo: {owner: 'diplodoc-platform', repo: 'infra'}, runId: 7},
            github: {paginate: async () => [], rest: {actions: {listJobsForWorkflowRun: 'jobs'}}},
        },
    };
}
const missingFiles = {
    existsSync: () => false,
    readFileSync: () => {
        throw new Error('missing report');
    },
};
const jsonFiles = (value) => ({...missingFiles, readFileSync: () => JSON.stringify(value)});

test('large workflow adapters are external modules loaded after a trusted checkout', () => {
    for (const [workflow, helper] of Object.entries(helpers)) {
        const data = yaml.load(
            fs.readFileSync(path.join(__dirname, '../../.github/workflows', workflow), 'utf8'),
        );
        const job = Object.values(data.jobs).find((entry) =>
            entry.steps?.some((step) => step.with?.script),
        );
        const index = job.steps.findIndex((step) => step.with?.script);
        assert.ok(
            job.steps.slice(0, index).some((step) => step.uses?.startsWith('actions/checkout@')),
        );
        const script = job.steps[index].with.script;
        assert.ok(script.includes(`require('./scripts/workflows/${helper}.js')`));
        assert.strictEqual(script.trim().split('\n').length, 2);
        assert.strictEqual(typeof run(helper), 'function');
    }
});

test('auto-merge adapter retains audit-only counts and warns on missing evidence', async () => {
    const {clients, output} = harness();
    await run('dependency-auto-merge-summary')(
        clients,
        {},
        jsonFiles([{allowed: true}, {skipped: true}, {mergeError: 'failed'}]),
    );
    assert.ok(output.summary.includes('DRY-RUN (audit only)'));
    assert.ok(output.summary.includes('Total evaluated: **3**'));
    assert.ok(output.summary.includes('Allowed: **1**'));
    await run('dependency-auto-merge-summary')(clients, {}, missingFiles);
    assert.strictEqual(output.warnings.length, 1);
});

test('incomplete auto-merge audit cannot look all clear or publish a tracking issue', async () => {
    for (const exitCode of ['1', '']) {
        const {clients, output} = harness();
        await run('dependency-auto-merge-summary')(
            clients,
            {AUDIT_EXIT_CODE: exitCode},
            jsonFiles([]),
        );
        assert.ok(output.summary.includes('UNKNOWN'));
        assert.ok(!output.summary.includes('Total evaluated: **0**'));
        assert.strictEqual(output.warnings.length, 1);
    }

    const workflow = yaml.load(
        fs.readFileSync(
            path.join(__dirname, '../../.github/workflows/dependency-auto-merge.yml'),
            'utf8',
        ),
    );
    const steps = workflow.jobs['auto-merge'].steps;
    assert.ok(steps.find((step) => step.id === 'automerge').run.includes('--dry-run'));
    const publication = steps.find((step) => step.name === 'Post audit log as tracking issue');
    assert.ok(publication.if.includes("steps.automerge.outputs.exit-code == '0'"));
    assert.ok(!publication.run.includes('|| echo'));
});

test('health adapter preserves health, daily and assignment report sections', async () => {
    const {clients, output} = harness();
    await run('dependency-health-summary')(
        clients,
        {},
        jsonFiles({
            summary: {totalPrs: 4},
            totals: {actionableItems: 2},
            actions: [1],
            issue: {number: 8, created: true},
        }),
    );
    for (const value of [
        'Total PRs: **4**',
        'Actionable items: **2**',
        'assignment actions: **1**',
        'Tracking issue: #8',
    ])
        assert.ok(output.summary.includes(value), value);
    const missing = harness();
    await run('dependency-health-summary')(missing.clients, {}, missingFiles);
    assert.strictEqual(missing.output.summary, '');
    assert.strictEqual(missing.output.warnings.length, 3);
});

test('health adapter marks incomplete audits UNKNOWN and exposes their errors', async () => {
    const {clients, output} = harness();
    await run('dependency-health-summary')(
        clients,
        {},
        jsonFiles({
            complete: false,
            errors: [{repo: 'tabs-extension', phase: 'list-prs', message: 'HTTP 503'}],
            summary: {totalPrs: 0},
            totals: {actionableItems: 0},
            actions: [],
        }),
    );
    assert.ok(output.summary.includes('Total PRs: **UNKNOWN**'));
    assert.ok(output.summary.includes('Actionable items: **UNKNOWN**'));
    assert.ok(output.summary.includes('assignment actions: **UNKNOWN**'));
    assert.ok(output.summary.includes('tabs-extension: list-prs — HTTP 503'));
    assert.ok(!output.summary.includes('**0**'));
    assert.strictEqual(output.warnings.length, 3);
});

test('health adapter treats assignment errors without a complete flag as unknown', async () => {
    const {clients, output} = harness();
    await run('dependency-health-summary')(
        clients,
        {},
        jsonFiles({
            errors: [{repo: 'tabs-extension', phase: 'assign', message: 'HTTP 403'}],
            actions: [],
        }),
    );
    assert.ok(output.summary.includes('assignment actions: **UNKNOWN**'));
    assert.ok(output.summary.includes('tabs-extension: assign — HTTP 403'));
});

test('aggregate report adapters fail on missing or malformed matrix evidence', async () => {
    for (const helper of ['ci-gate-report', 'distribution-report']) {
        for (const files of [
            missingFiles,
            {
                ...missingFiles,
                existsSync: () => true,
                readdirSync: () => ['status-tabs-extension.json'],
            },
        ]) {
            const {clients, output} = harness();
            await run(helper)(
                clients,
                {REPOS_JSON: '["tabs-extension"]', VERSION: 'v2.2.3'},
                files,
            );
            assert.strictEqual(output.failures.length, 1);
            assert.ok(output.summary.includes('tabs-extension'));
            assert.ok(output.summary.includes('Failed: **1**'));
        }
        const {clients, output} = harness();
        await run(helper)(
            clients,
            {REPOS_JSON: '["tabs-extension"]'},
            {
                ...jsonFiles({repo: 'tabs-extension', status: 'updated', contexts: []}),
                existsSync: () => true,
                readdirSync: () => ['status-tabs-extension.json'],
            },
        );
        assert.strictEqual(output.failures.length, 0);
        assert.ok(output.summary.includes('Updated: **1**'));
    }
});

test('PAT adapter leaves a healthy PAT untouched and fails on unreadable evidence', async () => {
    const {clients, output} = harness();
    // There are deliberately no issue APIs in this mock: healthy evidence must not mutate GitHub.
    await run('pat-expiry-alert')(
        clients,
        {},
        jsonFiles({status: 'ok', login: 'bot', daysLeft: 30}),
    );
    assert.strictEqual(output.failures.length, 0);
    assert.strictEqual(output.notices.length, 1);
    await run('pat-expiry-alert')(clients, {}, missingFiles);
    assert.strictEqual(output.failures.length, 1);
});

test('PAT adapter retains issue creation and fatal expiry handling using mocked APIs', async () => {
    const {clients, output} = harness();
    const writes = [];
    clients.github.rest.teams = {listMembersInOrg: 'members'};
    clients.github.rest.issues = {
        listForRepo: async () => ({data: []}),
        createLabel: async (value) => writes.push({type: 'label', ...value}),
        create: async (value) => {
            writes.push({type: 'issue', ...value});
            return {data: {number: 12}};
        },
    };
    await run('pat-expiry-alert')(
        clients,
        {},
        jsonFiles({status: 'expired', login: 'bot', daysLeft: -1}),
    );
    assert.deepStrictEqual(
        writes.map((entry) => entry.type),
        ['label', 'issue'],
    );
    assert.deepStrictEqual(writes[1].labels, ['pat-rotation']);
    assert.strictEqual(output.failures.length, 1);
});

module.exports = {tests};
