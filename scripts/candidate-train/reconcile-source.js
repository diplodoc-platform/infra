'use strict';

const assert = require('node:assert/strict');
const {changedInput} = require('./automatic-groups');
const {OWNER, SHA, pages} = require('./common');
const {reconciliationSeed, reconcileLock} = require('./reconcile-lock');
const {assertPreparedCI} = require('./prepare-ci');

/** Re-derive a prepared source against its exact, still-current Dependabot seed. */
async function readReconciledInput(
    pr,
    before,
    after,
    oldLock,
    revisedLock,
    cli,
    cliLock,
    readSource,
    request,
) {
    const identity = reconciliationSeed(pr);
    assert.ok(identity, 'Invalid reconciliation branch or author');
    const repo = pr.base.repo.name;
    const prefix = `/repos/${OWNER}/${repo}`;
    await assertPreparedCI(repo, pr.base.sha, request);
    const seed = await request(`${prefix}/pulls/${identity.number}`);
    assert.equal(seed.number, identity.number);
    assert.equal(seed.state, 'open', 'Original Dependabot PR is closed');
    assert.equal(seed.draft, false);
    assert.equal(seed.user?.login, 'dependabot[bot]');
    assert.equal(seed.base.ref, 'master');
    assert.equal(seed.base.repo?.full_name, `${OWNER}/${repo}`);
    assert.equal(seed.head.repo?.full_name, `${OWNER}/${repo}`);
    assert.equal(seed.head.sha, identity.sha, 'Original Dependabot PR changed');
    assert.equal(seed.base.sha, pr.base.sha, 'Original Dependabot PR base changed');
    assert.match(seed.head.sha, SHA);
    const files = await pages(`${prefix}/pulls/${seed.number}/files`, request);
    assert.ok(
        files.length &&
            files.every(
                ({filename, status}) =>
                    ['package.json', 'package-lock.json'].includes(filename) &&
                    status === 'modified',
            ),
    );
    const [manifest, lock] = await Promise.all(
        ['package.json', 'package-lock.json'].map((file) =>
            readSource(repo, seed.head.sha, file).then(JSON.parse),
        ),
    );
    assert.deepEqual(after, manifest, 'Reconciliation changed the original PR manifest');
    const input = changedInput(before, manifest, oldLock, lock);
    const expected = reconcileLock(oldLock, lock, cliLock, cli.manifest, input.name);
    assert.ok(expected.changes.length, 'Reconciliation has no additional dependency changes');
    assert.deepEqual(
        revisedLock,
        expected.lock,
        'Reconciliation lock differs from canonical inputs',
    );
    return {input, seed: seed.number, additional: expected.changes.map(({name}) => name)};
}

module.exports = {readReconciledInput};
