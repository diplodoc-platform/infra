'use strict';

const assert = require('node:assert/strict');
const {OWNER, SHA, pages} = require('./common');

async function selectMergeMethod(repo, request) {
    const prefix = `/repos/${OWNER}/${repo}`;
    const [settings, rules] = await Promise.all([
        request(prefix),
        pages(`${prefix}/rules/branches/master`, request),
    ]);
    const restrictions = rules
        .filter((rule) => rule.type === 'pull_request')
        .map((rule) => rule.parameters?.allowed_merge_methods);
    assert.ok(
        !restrictions.some((methods) => methods !== undefined && !Array.isArray(methods)),
        `${repo}: invalid merge method rules`,
    );

    const method = ['squash', 'rebase'].find(
        (name) =>
            settings[`allow_${name}_merge`] === true &&
            restrictions.every((methods) => methods === undefined || methods.includes(name)),
    );
    assert.ok(method, `${repo}: GitHub does not allow squash or rebase on master`);
    return method;
}

/** Record the tree at every commit in the tested linear rebase history, newest first. */
async function rebaseTrees(item, count, request) {
    assert.ok(
        Number.isSafeInteger(count) && count > 0 && count <= 250,
        `${item.repo}: invalid rebase commit count`,
    );
    const prefix = `/repos/${OWNER}/${item.repo}`;
    const trees = [];
    let sha = item.sha;

    for (let index = 0; index < count; index++) {
        assert.notEqual(
            sha,
            item.baseSha,
            `${item.repo}: rebase reached the base before the PR history ended`,
        );
        const commit = await request(`${prefix}/git/commits/${sha}`);
        assert.match(commit.tree?.sha || '', SHA);
        assert.equal(
            commit.parents?.length,
            1,
            `${item.repo}: rebase requires a linear PR history`,
        );
        sha = commit.parents[0].sha;
        assert.match(sha, SHA);
        trees.push(commit.tree.sha);
    }

    assert.equal(sha, item.baseSha, `${item.repo}: rebase history must start at the verified base`);
    return trees;
}

async function verifyRebase(item, tip, trees, request) {
    const prefix = `/repos/${OWNER}/${item.repo}`;
    let commit = tip;
    for (const [index, tree] of trees.entries()) {
        assert.equal(
            commit.tree?.sha,
            tree,
            `${item.repo}: rebased tree differs from the verified PR`,
        );
        assert.equal(commit.parents?.length, 1, `${item.repo}: rebased history is not linear`);
        const parent = commit.parents[0].sha;
        assert.match(parent, SHA);
        if (index === trees.length - 1) {
            assert.equal(
                parent,
                item.baseSha,
                `${item.repo}: rebased history differs from the verified baseline`,
            );
        } else {
            assert.notEqual(
                parent,
                item.baseSha,
                `${item.repo}: rebased history is shorter than the verified PR`,
            );
            commit = await request(`${prefix}/git/commits/${parent}`);
        }
    }
}

module.exports = {selectMergeMethod, rebaseTrees, verifyRebase};
