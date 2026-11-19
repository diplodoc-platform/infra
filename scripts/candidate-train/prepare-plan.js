'use strict';

const assert = require('node:assert/strict');
const {OWNER, SHA, pages} = require('./common');
const {BOT, preparedBranch, preparationSection, touchesInput} = require('./prepare-policy');

async function readInputs(readSource, repo, base, head) {
    return Promise.all([
        readSource(repo, base, 'package.json'),
        readSource(repo, head, 'package.json'),
        readSource(repo, base, 'package-lock.json'),
        readSource(repo, head, 'package-lock.json'),
    ]).then((files) => files.map(JSON.parse));
}

async function assertNoCompetingPull(repo, name, pulls, readSource, request) {
    for (const pr of pulls) {
        const files = await pages(`/repos/${OWNER}/${repo}/pulls/${pr.number}/files`, request);
        if (!files.some(({filename}) => ['package.json', 'package-lock.json'].includes(filename)))
            continue;
        assert.match(pr.base.sha, SHA);
        assert.match(pr.head.sha, SHA);
        const comparison = await request(
            `/repos/${OWNER}/${repo}/compare/${pr.base.sha}...${pr.head.sha}?per_page=1`,
        );
        const mergeBase = comparison.merge_base_commit?.sha;
        assert.match(mergeBase, SHA);
        const values = await readInputs(readSource, repo, mergeBase, pr.head.sha);
        assert.ok(!touchesInput(...values, name), `${repo}#${pr.number} already changes ${name}`);
    }
}

/** Select at most one group before npm runs, leaving ordinary candidate admission unchanged. */
async function findPreparation(groups, graph, masters, pulls, readSource, request) {
    const blocked = [];
    for (const group of groups) {
        try {
            const missing = [];
            for (const repo of group.missing) {
                const node = graph.find((item) => item.repo === repo);
                assert.equal(
                    masters.get(repo),
                    node.sha,
                    `${repo}: update metapackage submodule first`,
                );
                const lock = JSON.parse(await readSource(repo, node.sha, 'package-lock.json'));
                preparationSection(node.manifest, lock, group.dependency);
                missing.push({repo, baseSha: node.sha});
            }
            const branch = preparedBranch(group.dependency);
            for (const {repo} of missing) {
                const previous = await pages(
                    `/repos/${OWNER}/${repo}/pulls?state=all&head=${BOT}:${encodeURIComponent(branch)}`,
                    request,
                );
                assert.equal(
                    previous.length,
                    0,
                    `${repo}: a prepared PR already exists for this target`,
                );
                await assertNoCompetingPull(
                    repo,
                    group.dependency.name,
                    pulls.get(repo),
                    readSource,
                    request,
                );
            }
            return {group: {...group, missing}, blocked};
        } catch (error) {
            blocked.push({dependency: group.dependency, reason: error.message});
        }
    }
    return {group: null, blocked};
}

module.exports = {findPreparation, assertNoCompetingPull};
