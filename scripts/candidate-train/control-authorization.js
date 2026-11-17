'use strict';

const assert = require('node:assert/strict');
const {OWNER} = require('./common');
const {VERIFIER_APP_ID} = require('./verdict');

const CONTROL_APP_ACTOR = 'diplodoc-app[bot]';
const REQUEST_MARKER = 'DEPENDENCY_TRAIN_REQUEST_V1';
const REQUEST_CHECK_NAME = 'Dependency train request';
const REQUEST_TTL_MS = 60 * 60 * 1000;
const LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i;

/** Permission evidence comes from GitHub now, not a caller-supplied association or role. */
async function requireOperatorWrite(repo, operator, request) {
    assert.match(operator.login, LOGIN);
    const permission = await request(
        `/repos/${OWNER}/${repo}/collaborators/${operator.login}/permission`,
    );
    assert.ok(
        ['admin', 'maintain', 'write'].includes(permission.permission),
        `${repo}: operator needs write access`,
    );
    assert.equal(permission.user?.login.toLowerCase(), operator.login.toLowerCase());
    assert.equal(permission.user?.type, 'User', 'A human operator is required');
    assert.ok(Number.isSafeInteger(permission.user.id) && permission.user.id > 0);
    if (operator.id !== undefined)
        assert.equal(permission.user.id, operator.id, 'Operator identity changed');
    return {login: permission.user.login, id: permission.user.id};
}

/** A signed App receipt authorizes only one exact operation and verified candidate. */
function validateControlReceipt(check, verified, expectedAction, now = Date.now()) {
    assert.equal(check.app?.id, VERIFIER_APP_ID, 'Untrusted control receipt issuer');
    assert.equal(check.name, REQUEST_CHECK_NAME);
    assert.equal(check.head_sha, verified.candidate.sha);
    assert.equal(check.status, 'completed');
    assert.equal(check.conclusion, 'neutral');
    const text = check.output?.text || '';
    assert.ok(text.length <= 16 * 1024);
    const parts = text.split(`\n${REQUEST_MARKER}\n`);
    assert.equal(parts.length, 2, 'Missing or ambiguous control receipt');
    const receipt = JSON.parse(parts[1]);
    assert.deepEqual(Object.keys(receipt).sort(), [
        'action',
        'candidate',
        'issuedAt',
        'operator',
        'payloadSha256',
        'planSha256',
        'requestId',
        'schema',
        'trainId',
        'verifierCheckId',
    ]);
    assert.equal(receipt.schema, 1);
    assert.match(receipt.requestId, /^[a-f0-9]{64}$/);
    assert.equal(check.external_id, `dependency-train-request:${receipt.requestId}`);
    assert.equal(
        receipt.action,
        expectedAction,
        'This request does not authorize the requested operation',
    );
    assert.deepEqual(receipt.candidate, verified.candidate);
    assert.equal(receipt.trainId, verified.plan.id);
    assert.equal(
        receipt.verifierCheckId,
        verified.checkId,
        'Verification was replaced after the request',
    );
    assert.equal(receipt.planSha256, verified.verdict.planSha256);
    assert.equal(receipt.payloadSha256, verified.verdict.payloadSha256);
    assert.deepEqual(Object.keys(receipt.operator).sort(), ['id', 'login']);
    assert.match(receipt.operator.login, LOGIN);
    assert.ok(!['diplodoc-bot', 'yc-ui-bot'].includes(receipt.operator.login));
    assert.ok(Number.isSafeInteger(receipt.operator.id) && receipt.operator.id > 0);
    const issued = Date.parse(receipt.issuedAt);
    const created = Date.parse(check.created_at);
    assert.ok(Number.isFinite(issued) && Number.isFinite(created));
    assert.ok(Math.abs(issued - created) <= 60 * 1000, 'Receipt timestamp is not server-bound');
    assert.ok(
        issued <= now + 30 * 1000 && now - issued <= REQUEST_TTL_MS,
        'Control receipt expired',
    );
    return receipt;
}

async function authorizeControl(env, verified, request) {
    let operator;
    if (env.REQUEST_CHECK_ID) {
        assert.equal(
            env.GITHUB_ACTOR,
            CONTROL_APP_ACTOR,
            'Only the trusted App may dispatch a control receipt',
        );
        assert.match(env.REQUEST_CHECK_ID, /^[1-9][0-9]*$/);
        assert.ok(Number.isSafeInteger(Number(env.REQUEST_CHECK_ID)));
        assert.ok(['preview', 'merge'].includes(env.REQUEST_ACTION));
        if (env.DEPENDENCY_TRAIN_MERGE_APPROVED === 'true')
            assert.equal(env.REQUEST_ACTION, 'merge');
        const check = await request(`/repos/${OWNER}/cli/check-runs/${env.REQUEST_CHECK_ID}`);
        operator = validateControlReceipt(check, verified, env.REQUEST_ACTION).operator;
    } else {
        assert.ok(
            env.GITHUB_ACTOR &&
                !env.GITHUB_ACTOR.endsWith('[bot]') &&
                !['diplodoc-bot', 'yc-ui-bot'].includes(env.GITHUB_ACTOR),
            'A human operator must request the merge',
        );
        operator = {login: env.GITHUB_ACTOR};
    }

    operator = await requireOperatorWrite('infra', operator, request);
    await requireOperatorWrite('cli', operator, request);
    return operator;
}

module.exports = {
    CONTROL_APP_ACTOR,
    REQUEST_MARKER,
    REQUEST_CHECK_NAME,
    REQUEST_TTL_MS,
    requireOperatorWrite,
    validateControlReceipt,
    authorizeControl,
};
