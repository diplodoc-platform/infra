const assert = require('node:assert');

const {
    classifyPr,
    shouldAutoApprove,
    commitsAllAuthoredBy,
} = require('../../scripts/match-auto-approve');

const tests = [];
function test(name, fn) {
    tests.push({name, fn});
}

// --- positive cases -------------------------------------------------------

test('update-deps by branch', () => {
    const pr = {
        author: 'yc-ui-bot',
        branch: 'ci/update-deps/_diplodoc_transform-latest',
        title: 'fix(deps): Update @diplodoc/transform@1.2.3',
    };
    assert.strictEqual(classifyPr(pr), 'update-deps');
    assert.strictEqual(shouldAutoApprove(pr), true);
});

test('update-deps by title only', () => {
    const pr = {author: 'yc-ui-bot', branch: 'whatever', title: 'fix(deps): Update foo@1'};
    assert.strictEqual(classifyPr(pr), 'update-deps');
});

test('release-please by branch', () => {
    const pr = {
        author: 'yc-ui-bot',
        branch: 'release-please--branches--master',
        title: 'chore(master): release 2.0.0',
    };
    assert.strictEqual(classifyPr(pr), 'release-please');
    assert.strictEqual(shouldAutoApprove(pr), true);
});

test('release-please by title only', () => {
    const pr = {author: 'yc-ui-bot', branch: 'misc', title: 'chore: release 1.0.0'};
    assert.strictEqual(classifyPr(pr), 'release-please');
});

// --- negative cases -------------------------------------------------------

test('wrong author is rejected', () => {
    const pr = {
        author: 'some-human',
        branch: 'ci/update-deps/foo',
        title: 'fix(deps): Update foo',
    };
    assert.strictEqual(classifyPr(pr), null);
    assert.strictEqual(shouldAutoApprove(pr), false);
});

test('approver must not self-approve (diplodoc-bot is not in author allowlist)', () => {
    const pr = {
        author: 'diplodoc-bot',
        branch: 'ci/update-deps/foo',
        title: 'fix(deps): Update foo',
    };
    assert.strictEqual(shouldAutoApprove(pr), false);
});

test('unrelated bot PR is rejected', () => {
    const pr = {author: 'yc-ui-bot', branch: 'feature/x', title: 'feat: add thing'};
    assert.strictEqual(classifyPr(pr), null);
});

test('empty input is safe', () => {
    assert.strictEqual(classifyPr(), null);
    assert.strictEqual(shouldAutoApprove({}), false);
});

// --- commitsAllAuthoredBy -------------------------------------------------

const botCommit = {author: {login: 'yc-ui-bot'}, committer: {login: 'yc-ui-bot'}};

test('commitsAllAuthoredBy: all by bot', () => {
    assert.strictEqual(commitsAllAuthoredBy([botCommit, botCommit], 'yc-ui-bot'), true);
});

test('commitsAllAuthoredBy: one foreign author fails', () => {
    const commits = [botCommit, {author: {login: 'mallory'}, committer: {login: 'yc-ui-bot'}}];
    assert.strictEqual(commitsAllAuthoredBy(commits, 'yc-ui-bot'), false);
});

test('commitsAllAuthoredBy: foreign committer fails', () => {
    const commits = [{author: {login: 'yc-ui-bot'}, committer: {login: 'mallory'}}];
    assert.strictEqual(commitsAllAuthoredBy(commits, 'yc-ui-bot'), false);
});

test('commitsAllAuthoredBy: missing login fails', () => {
    const commits = [{author: {}, committer: {login: 'yc-ui-bot'}}];
    assert.strictEqual(commitsAllAuthoredBy(commits, 'yc-ui-bot'), false);
});

test('commitsAllAuthoredBy: empty list fails (nothing to trust)', () => {
    assert.strictEqual(commitsAllAuthoredBy([], 'yc-ui-bot'), false);
    assert.strictEqual(commitsAllAuthoredBy(undefined, 'yc-ui-bot'), false);
});

module.exports = {tests};
