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
const distribution = yaml.load(readFileSync(join(__dirname, '../../distribution.yml'), 'utf8'));

test('keeps dependency auto-merge manual during stabilization', () => {
    assert.match(workflowSource, /^\s*workflow_dispatch:\s*$/m);
    assert.doesNotMatch(workflowSource, /^\s*schedule:\s*$/m);
    assert.doesNotMatch(workflowSource, /vars\.AUTOMERGE_ENABLED/);
    assert.doesNotMatch(workflowSource, /inputs\.enabled/);
    assert.doesNotMatch(workflowSource, /--enabled/);
    assert.match(workflowSource, /DRY-RUN \(audit only\)/);
});

test('keeps every distribution target review-only by default', () => {
    assert.strictEqual(distribution.defaults.auto_merge, false);

    for (const [repo, config] of Object.entries(distribution.repos)) {
        assert.notStrictEqual(config.auto_merge, true, `${repo} must not opt into auto-merge`);
    }
});

module.exports = {tests};
