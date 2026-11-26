'use strict';

const assert = require('node:assert/strict');
const {OWNER, SHA} = require('./common');

// Review the workflow directory before permitting candidate code to run in the base repository.
const WORKFLOW_TREES = Object.freeze({
    'algolia-extension': 'ace8f091ee94ac000b0186107ee7e6ac7451af1a',
    components: '497eb367ebeaa37bc1c4f970b1e6eca06cfde150',
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
