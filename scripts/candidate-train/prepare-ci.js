'use strict';

const assert = require('node:assert/strict');
const {OWNER, SHA} = require('./common');

const WORKFLOW_TREES = require('../reviewed-workflow-trees.json');

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
    assert.ok(
        WORKFLOW_TREES[repo].includes(workflows?.sha),
        `${repo}: workflow tree differs from the reviewed candidate CI`,
    );
}

module.exports = {assertPreparedCI};
