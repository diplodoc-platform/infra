const assert = require('node:assert');
const {mkdtempSync, writeFileSync, rmSync, readFileSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join, resolve} = require('node:path');
const {spawnSync} = require('node:child_process');

const {githubData, githubRequest} = require('../../scripts/github-request');
const {validateSnapshot, readSnapshot} = require('../../scripts/inventory-snapshot');
const {runHealthAudit, renderHealthMarkdown} = require('../../scripts/dependency-health');
const {
    runSummary,
    fetchFileContent,
    unpinnedVersions,
    renderSummaryMarkdown,
} = require('../../scripts/dependency-summary');
const {
    runAssign,
    findTrackingIssue,
    renderTrackingIssue,
} = require('../../scripts/dependency-assign');

const tests = [];
const test = (name, fn) => tests.push({name, fn});
const scope = {owner: 'test-org', repos: ['tabs'], skipChecks: true};
const now = new Date('2026-10-23T05:00:00.000Z');
const snapshot = (errors = [], inventory = []) => ({
    schema: 1,
    owner: scope.owner,
    repositories: scope.repos,
    skipChecks: true,
    capturedAt: now.toISOString(),
    inventory,
    errors,
});
const response = (status, json) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(json),
});
const fileResponse = (content) =>
    response(200, {
        encoding: 'base64',
        content: Buffer.from(content).toString('base64'),
    });

async function withFetch(mock, fn) {
    const original = global.fetch;
    global.fetch = mock;
    try {
        await fn();
    } finally {
        global.fetch = original;
    }
}

for (const status of [403, 503]) {
    test(`report files: HTTP ${status} is an error, not optional absence`, async () => {
        await withFetch(
            async () => response(status, {message: 'unavailable'}),
            async () => {
                await assert.rejects(
                    fetchFileContent('test-token', 'test-org', 'tabs', 'package.json'),
                    (error) => error.status === status,
                );
            },
        );
    });
}

test('report files: only HTTP 404 represents optional absence', async () => {
    await withFetch(
        async () => response(404, {message: 'Not Found'}),
        async () => {
            assert.strictEqual(
                await fetchFileContent('t', 'o', 'r', '.github/dependabot.yml'),
                null,
            );
        },
    );
});

for (const body of [
    null,
    {},
    {encoding: 'none', content: ''},
    {encoding: 'base64', content: '???'},
]) {
    test(`report files: incomplete Contents response is rejected (${JSON.stringify(body)})`, async () => {
        await withFetch(
            async () => response(200, body),
            async () => {
                await assert.rejects(fetchFileContent('t', 'o', 'r', 'package.json'));
            },
        );
    });
}

test('GitHub JSON transport rejects malformed successful responses and retains status', async () => {
    await withFetch(
        async () => ({ok: true, status: 200, text: async () => 'not JSON'}),
        async () => {
            await assert.rejects(githubData('t', '/test'), /Invalid JSON/);
        },
    );
    await withFetch(
        async () => ({ok: false, status: 503, text: async () => 'unavailable'}),
        async () => {
            await assert.rejects(githubData('t', '/test'), (error) => error.status === 503);
        },
    );
});

test('GitHub JSON transport preserves write body, status and custom user agent', async () => {
    await withFetch(
        async (url, options) => {
            assert.strictEqual(url, 'https://api.github.com/test');
            assert.strictEqual(options.method, 'PATCH');
            assert.strictEqual(options.headers['User-Agent'], 'test-agent');
            assert.deepStrictEqual(JSON.parse(options.body), {body: 'test'});
            return response(201, {number: 1});
        },
        async () => {
            assert.deepStrictEqual(
                await githubRequest('t', 'PATCH', '/test', {body: 'test'}, 'test-agent'),
                {ok: true, status: 201, json: {number: 1}},
            );
        },
    );
});

test('summary: managed infra pins receive repository and dependency-section context', () => {
    const entries = [
        {
            dependency: '@diplodoc/infra',
            'pin-policy': 'managed-infra',
            repositories: ['tabs'],
            'expires-at': '2099-01-01',
        },
    ];
    assert.deepStrictEqual(
        unpinnedVersions('tabs', {devDependencies: {'@diplodoc/infra': '2.2.3'}}, entries, now),
        [],
    );
    assert.strictEqual(
        unpinnedVersions('tabs', {dependencies: {'@diplodoc/infra': '2.2.3'}}, entries, now).length,
        1,
    );
    assert.strictEqual(
        unpinnedVersions('cut', {devDependencies: {'@diplodoc/infra': '2.2.3'}}, entries, now)
            .length,
        1,
    );
});

for (const manifest of [
    null,
    'not JSON',
    'null',
    '[]',
    '{}',
    '{"name":"tabs","dependencies":[]}',
]) {
    test(`summary: missing or invalid mandatory manifest fails closed (${manifest})`, async () => {
        await withFetch(
            async (url) => {
                if (url.endsWith('/package.json'))
                    return manifest === null ? response(404, {}) : fileResponse(manifest);
                return response(404, {});
            },
            async () => {
                const result = await runSummary({...scope, snapshot: snapshot()});
                assert.strictEqual(result.errors.length, 1);
                assert.strictEqual(result.summary.complete, false);
                assert.ok(!renderSummaryMarkdown(result.summary).includes('All clear.'));
            },
        );
    });
}

test('summary: optional missing Dependabot config uses default; invalid present config does not', async () => {
    for (const config of [
        null,
        'updates: [',
        'version: 2\nupdates: [{open-pull-requests-limit: broken}]',
    ]) {
        await withFetch(
            async (url) =>
                url.endsWith('/package.json')
                    ? fileResponse('{"name":"tabs"}')
                    : config === null
                      ? response(404, {})
                      : fileResponse(config),
            async () => {
                const {summary, errors} = await runSummary({...scope, snapshot: snapshot()});
                assert.strictEqual(summary.complete, config === null);
                assert.strictEqual(errors.length, config === null ? 0 : 1);
            },
        );
    }
});

test('audit snapshot binds owner, repository scope, check mode and required shape', () => {
    assert.strictEqual(validateSnapshot(snapshot(), scope).schema, 1);
    for (const changes of [
        {owner: 'other'},
        {repositories: ['cut']},
        {skipChecks: false},
        {errors: null},
        {inventory: [{}]},
        {capturedAt: 'bad'},
    ]) {
        assert.throws(() => validateSnapshot({...snapshot(), ...changes}, scope), /snapshot/);
    }
});

test('incomplete inventory is preserved; no assignments or tracking issue writes occur', async () => {
    const errors = [{repo: 'tabs', phase: 'list-prs', message: 'HTTP 503'}];
    const partialInventory = [
        {
            repo: 'tabs',
            number: 160,
            createdAt: '2026-01-01T00:00:00Z',
            ageDays: 295,
            security: true,
            assignees: [],
            checkStatus: 'passing',
            risk: 'critical',
            updateType: 'patch',
        },
    ];
    await withFetch(
        async () => {
            throw new Error('No network calls permitted');
        },
        async () => {
            const result = await runAssign({
                ...scope,
                snapshot: snapshot(errors, partialInventory),
            });
            assert.deepStrictEqual(result.errors, errors);
            assert.deepStrictEqual(result.actions, []);
            assert.strictEqual(result.issue, null);
            assert.strictEqual(result.health.summary.breachingPrs, 1);
            const markdown = renderTrackingIssue(result.health, []);
            assert.ok(markdown.includes('Incomplete audit'));
            assert.ok(!markdown.includes('No SLA breaches detected'));
        },
    );
});

test('failed repository listing cannot produce a green health report', async () => {
    await withFetch(
        async () => response(503, {message: 'unavailable'}),
        async () => {
            const result = await runHealthAudit({...scope, token: 'test-token'});
            assert.strictEqual(result.errors.length, 1);
            assert.strictEqual(result.health.complete, false);
            assert.ok(renderHealthMarkdown(result.health).includes('Incomplete audit'));
        },
    );
});

for (const malformed of ['pr-list', 'combined-status', 'check-runs', 'check-run-entry']) {
    test(`malformed ${malformed} evidence fails every report closed without issue writes`, async () => {
        const scoped = {...scope, skipChecks: false};
        let mutations = 0;
        await withFetch(
            async (url, options = {}) => {
                if (options.method && options.method !== 'GET') {
                    mutations++;
                    throw new Error('Unexpected mutation');
                }
                if (url.includes('/pulls?')) {
                    return response(
                        200,
                        malformed === 'pr-list'
                            ? {message: 'incomplete'}
                            : [
                                  {
                                      number: 160,
                                      title: 'Bump example from 1.0.0 to 1.0.1',
                                      user: {login: 'dependabot[bot]'},
                                      created_at: '2026-10-22T00:00:00Z',
                                      head: {sha: 'a'.repeat(40)},
                                  },
                              ],
                    );
                }
                if (url.endsWith('/status')) {
                    return response(
                        200,
                        malformed === 'combined-status'
                            ? {}
                            : {
                                  state: 'pending',
                                  total_count: 0,
                                  statuses: [],
                              },
                    );
                }
                if (url.includes('/check-runs?')) {
                    return response(
                        200,
                        malformed === 'check-runs'
                            ? {}
                            : {
                                  check_runs: malformed === 'check-run-entry' ? [{}] : [],
                              },
                    );
                }
                if (url.endsWith('/package.json')) return fileResponse('{"name":"tabs"}');
                if (url.includes('/contents/')) return response(404, {});
                throw new Error(`Unexpected request ${url}`);
            },
            async () => {
                const health = await runHealthAudit({...scoped, token: 'test-token', now});
                assert.strictEqual(health.health.complete, false);
                assert.strictEqual(health.errors.length, 1);
                assert.strictEqual(
                    health.errors[0].phase,
                    malformed === 'pr-list' ? 'list-prs' : 'check-status',
                );
                const summary = await runSummary({
                    ...scoped,
                    token: 'test-token',
                    snapshot: health.snapshot,
                });
                assert.strictEqual(summary.summary.complete, false);
                assert.ok(!renderSummaryMarkdown(summary.summary).includes('All clear.'));
                const assignment = await runAssign({
                    ...scoped,
                    token: 'test-token',
                    snapshot: health.snapshot,
                });
                assert.strictEqual(assignment.errors.length, 1);
                assert.deepStrictEqual(assignment.actions, []);
                assert.strictEqual(assignment.issue, null);
                assert.strictEqual(mutations, 0);
            },
        );
    });
}

test('tracking issue search errors never become an empty successful search', async () => {
    for (const result of [
        response(403, {}),
        response(200, {}),
        response(200, {items: [], incomplete_results: true}),
    ]) {
        await withFetch(
            async () => result,
            async () => {
                await assert.rejects(findTrackingIssue('t', 'o', 'r', 'title'));
            },
        );
    }
});

test('health + summary + assignment reuse one inventory without repeated PR requests', async () => {
    const routes = [];
    await withFetch(
        async (url) => {
            routes.push(url);
            if (url.includes('/pulls?')) return response(200, []);
            if (url.endsWith('/package.json')) return fileResponse('{"name":"tabs"}');
            if (url.includes('/contents/')) return response(404, {});
            throw new Error(`Unexpected network request: ${url}`);
        },
        async () => {
            const first = await runHealthAudit({...scope, token: 't', now});
            const summary = await runSummary({...scope, token: 't', snapshot: first.snapshot});
            const assign = await runAssign({...scope, snapshot: first.snapshot, dryRun: true});
            assert.strictEqual(routes.filter((url) => url.includes('/pulls?')).length, 1);
            assert.strictEqual(summary.summary.complete, true);
            assert.strictEqual(assign.errors.length, 0);
            assert.strictEqual(summary.summary.generatedAt, now.toISOString());
        },
    );
});

test('CLI reports fail on incomplete shared inventory and never perform writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'infra-report-test-'));
    try {
        const snapshotFile = join(dir, 'snapshot.json');
        const preload = join(dir, 'no-network.cjs');
        writeFileSync(
            snapshotFile,
            JSON.stringify(snapshot([{repo: 'tabs', phase: 'list-prs', message: 'HTTP 503'}])),
        );
        writeFileSync(
            preload,
            `global.fetch = async (url, options = {}) => {
            if (options.method && options.method !== 'GET') throw new Error('Unexpected mutation');
            const content = url.endsWith('/package.json') ? {encoding:'base64',content:Buffer.from('{"name":"tabs"}').toString('base64')} : {};
            return {ok:url.endsWith('/package.json'),status:url.endsWith('/package.json')?200:404,text:async()=>JSON.stringify(content)};
        };`,
        );
        assert.strictEqual(readSnapshot(snapshotFile, scope).errors.length, 1);
        for (const script of ['dependency-health', 'dependency-summary', 'dependency-assign']) {
            const result = spawnSync(
                process.execPath,
                [
                    '-r',
                    preload,
                    resolve(__dirname, '../../scripts', `${script}.js`),
                    '--owner',
                    scope.owner,
                    '--repo',
                    'tabs',
                    '--skip-checks',
                    '--snapshot',
                    snapshotFile,
                ],
                {
                    encoding: 'utf8',
                    env: {...process.env, GH_TOKEN: 'test-token', GITHUB_TOKEN: ''},
                },
            );
            assert.strictEqual(result.status, 1, `${script}: ${result.stderr}`);
            const output = JSON.parse(result.stdout);
            assert.strictEqual(output.errors.length, 1);
        }
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});

test('health workflow fetches once and guards publication on complete evidence', () => {
    const workflow = readFileSync(
        resolve(__dirname, '../../.github/workflows/dependency-health.yml'),
        'utf8',
    );
    assert.strictEqual((workflow.match(/--snapshot-output /g) || []).length, 1);
    assert.strictEqual(
        (workflow.match(/--snapshot \.status\/dependency-inventory.json/g) || []).length,
        2,
    );
    assert.ok(workflow.includes("steps.summary.outputs.complete == 'true'"));
    assert.ok(!workflow.includes('2>/dev/null || echo'));
});

module.exports = {tests};
