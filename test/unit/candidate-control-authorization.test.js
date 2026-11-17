const assert = require('node:assert/strict');
const {fixture} = require('./candidate-merge.test');
const {mergeTrain} = require('../../scripts/candidate-train/merge');
const {VERIFIER_APP_ID} = require('../../scripts/candidate-train/verdict');
const {
    CONTROL_APP_ACTOR,
    REQUEST_MARKER,
    REQUEST_CHECK_NAME,
    REQUEST_TTL_MS,
    validateControlReceipt,
} = require('../../scripts/candidate-train/control-authorization');

const tests = [];
const test = (name, fn) => tests.push({name, fn});

function authorized(action = 'merge') {
    const f = fixture();
    const now = new Date().toISOString();
    const receipt = {
        schema: 1,
        requestId: 'a'.repeat(64),
        action,
        candidate: f.candidate,
        trainId: f.plan.id,
        planSha256: f.verdict.planSha256,
        payloadSha256: f.verdict.payloadSha256,
        verifierCheckId: 10,
        operator: {login: 'maintainer', id: 7},
        issuedAt: now,
    };
    const check = {
        id: 123,
        name: REQUEST_CHECK_NAME,
        app: {id: VERIFIER_APP_ID},
        head_sha: f.candidate.sha,
        status: 'completed',
        conclusion: 'neutral',
        started_at: now,
        completed_at: now,
        external_id: `dependency-train-request:${receipt.requestId}`,
        output: {text: `Manual request\n${REQUEST_MARKER}\n${JSON.stringify(receipt)}`},
    };
    f.authorization = check;
    const env = {GITHUB_ACTOR: CONTROL_APP_ACTOR, REQUEST_CHECK_ID: '123', REQUEST_ACTION: action};
    return {
        f,
        check,
        receipt,
        env,
        refresh: () => {
            check.output.text = `Manual request\n${REQUEST_MARKER}\n${JSON.stringify(receipt)}`;
        },
    };
}

test('a REST check with started_at and no created_at authorizes preview without merge writes', async () => {
    const {f, env, check} = authorized('preview');
    assert.equal(Object.hasOwn(check, 'created_at'), false);
    const report = await f.run(false, env);
    assert.equal(report.operator.login, 'maintainer');
    assert.equal(report.requestCheckId, 123);
    assert.deepEqual(f.writes, []);
});

test('a fresh exact merge request retains all group checks and never merges the temporary CLI PR', async () => {
    const {f, env} = authorized();
    await f.run(true, env);
    assert.deepEqual(
        f.writes.map((item) => [item.repo, item.method]),
        [
            ['alpha', 'PUT'],
            ['beta', 'PUT'],
            ['cli', 'PATCH'],
        ],
    );
});

for (const change of [
    'issuer',
    'candidate',
    'plan',
    'payload',
    'verifier',
    'train',
    'expired',
    'future',
    'operator',
    'purpose',
    'ambiguous',
]) {
    test(`control ${change} is rejected before merging any source`, async () => {
        const {f, env, check, receipt, refresh} = authorized();
        if (change === 'issuer') check.app.id = 999;
        if (change === 'candidate') check.head_sha = '0'.repeat(40);
        if (change === 'plan') receipt.planSha256 = '0'.repeat(64);
        if (change === 'payload') receipt.payloadSha256 = '0'.repeat(64);
        if (change === 'verifier') receipt.verifierCheckId = 11;
        if (change === 'train') receipt.trainId = '0'.repeat(16);
        if (change === 'expired')
            receipt.issuedAt = check.started_at = new Date(
                Date.now() - REQUEST_TTL_MS - 1000,
            ).toISOString();
        if (change === 'future')
            receipt.issuedAt = check.started_at = new Date(Date.now() + 60_000).toISOString();
        if (change === 'operator') receipt.operator.id = 8;
        if (change === 'purpose') receipt.action = 'preview';
        refresh();
        if (change === 'ambiguous') check.output.text += `\n${REQUEST_MARKER}\n{}`;
        await assert.rejects(f.run(true, env));
        assert.deepEqual(f.writes, []);
    });
}

test('a preview receipt cannot be promoted into a live merge by workflow inputs', async () => {
    const {f, env} = authorized('preview');
    await assert.rejects(f.run(true, {...env, REQUEST_ACTION: 'merge'}));
    await assert.rejects(f.run(true, env));
    assert.deepEqual(f.writes, []);
});

test('a receipt cannot be used by another App or a human actor to impersonate its original dispatcher', async () => {
    for (const actor of ['another-app[bot]', 'maintainer', 'github-actions[bot]']) {
        const {f, env} = authorized();
        await assert.rejects(f.run(true, {...env, GITHUB_ACTOR: actor}));
        assert.deepEqual(f.writes, []);
    }
});

for (const repo of ['infra', 'cli', 'alpha', 'beta']) {
    test(`current operator rights in ${repo} are independently rechecked at execution`, async () => {
        const {f, env} = authorized();
        f.deniedRepo = repo;
        await assert.rejects(f.run(true, env), /operator needs write access/);
        assert.deepEqual(f.writes, []);
    });
}

test('permission revocation after a partial merge stops the next write', async () => {
    const {f, env} = authorized();
    f.revokeAfterMerge = true;
    await assert.rejects(f.run(true, env), /operator needs write access/);
    assert.deepEqual(
        f.writes.map((item) => item.repo),
        ['alpha'],
    );
});

test('a timestamp controlled only by the receipt cannot refresh an old request', () => {
    const {f, check, receipt, refresh} = authorized();
    check.started_at = new Date(Date.now() - REQUEST_TTL_MS - 1000).toISOString();
    receipt.issuedAt = new Date().toISOString();
    refresh();
    assert.throws(() => validateControlReceipt(check, f.verified, 'merge'), /server-bound/);
});

test('missing or invalid check start time cannot fall back to receipt or completion timestamps', async () => {
    for (const started of [undefined, null, '', 'not-a-date']) {
        const {f, env, check} = authorized();
        check.started_at = started;
        check.created_at = check.completed_at;
        await assert.rejects(f.run(true, env), /check start time is missing or invalid/);
        assert.deepEqual(f.writes, []);
    }
});

test('read-only authority/baseline traffic and merge mutations use separate scoped tokens', async () => {
    const f = fixture();
    const original = global.fetch;
    const seen = [];
    global.fetch = async (url, options) => {
        const route = new URL(url).pathname;
        const method = options.method;
        const readonly = method === 'GET' || route === '/graphql';
        assert.equal(options.headers.Authorization, `Bearer ${readonly ? 'reader' : 'writer'}`);
        seen.push({route, readonly});
        const data = await f.request(route, {
            method,
            ...(options.body ? {body: JSON.parse(options.body)} : {}),
        });
        return new Response(JSON.stringify(data), {status: 200});
    };
    const evidence = Object.fromEntries(
        Object.entries(f.evidence).map(([key, fn]) => [
            key,
            async (token, ...args) => {
                assert.equal(token, 'reader');
                return fn(token, ...args);
            },
        ]),
    );
    try {
        await mergeTrain(
            {
                ...f.environment,
                GH_TOKEN: 'writer',
                GH_READ_TOKEN: 'reader',
                DEPENDENCY_TRAIN_MERGE_APPROVED: 'true',
            },
            undefined,
            evidence,
        );
    } finally {
        global.fetch = original;
    }
    assert.ok(seen.some((item) => item.route.includes('/infra/') && item.readonly));
    assert.ok(seen.some((item) => item.route.includes('/diplodoc/') && item.readonly));
    assert.ok(
        seen
            .filter((item) => !item.readonly)
            .every((item) => !item.route.includes('/infra/') && !item.route.includes('/diplodoc/')),
    );
});

module.exports = {tests};
