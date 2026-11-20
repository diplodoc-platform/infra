'use strict';

const assert = require('node:assert/strict');
const {OWNER, SHA} = require('./common');

// Review the workflow directory before permitting candidate code to run in the base repository.
const WORKFLOW_TREES = Object.freeze({
    components: 'eb68acbe3c407ccefc1ec2fe64fda41f5da273e2',
    transform: 'c722ab7b6f3c908cac6913a41a0f9cc98c7f66cb',
});

async function assertPreparedCI(repo, sha, request) {
    assert.ok(
        Object.hasOwn(WORKFLOW_TREES, repo),
        `${repo}: CI has not been reviewed for prepared PRs`,
    );
    assert.match(sha, SHA);

    const tree = await request(`/repos/${OWNER}/${repo}/git/trees/${sha}?recursive=1`);
    assert.equal(tree.truncated, false, `${repo}: cannot verify the full workflow tree`);
    const workflows = tree.tree.find(
        ({path, type}) => path === '.github/workflows' && type === 'tree',
    );
    assert.equal(
        workflows?.sha,
        WORKFLOW_TREES[repo],
        `${repo}: workflow tree differs from the reviewed candidate CI`,
    );
}

module.exports = {assertPreparedCI};
