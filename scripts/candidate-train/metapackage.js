'use strict';

const assert = require('node:assert/strict');
const {OWNER, SHA, fileAt, github} = require('./common');

/** The planner reads these immutable package registrations, not the root workspace. */
async function packageRegistrationsAt(sha, request = github) {
    assert.match(sha, SHA);
    const tree = await request(`/repos/${OWNER}/diplodoc/git/trees/${sha}?recursive=1`);
    assert.equal(tree.truncated, false, 'Incomplete metapackage tree');
    const modules = await fileAt('diplodoc', sha, '.gitmodules', request);
    const registrations = new Map();
    const repos = new Set();

    for (const block of modules.split(/(?=\[submodule )/)) {
        const directory = /^\s*path\s*=\s*((?:packages|extensions)\/[a-z0-9-]+)\s*$/m.exec(
            block,
        )?.[1];
        const repo = /github\.com[:/]diplodoc-platform\/([a-z0-9-]+?)(?:\.git)?\s*$/m.exec(
            block,
        )?.[1];
        if (!directory || !repo) continue;

        const commit = tree.tree.find((item) => item.path === directory && item.type === 'commit');
        assert.ok(commit && SHA.test(commit.sha), `Missing registered submodule ${directory}`);
        assert.ok(
            !registrations.has(directory) && !repos.has(repo),
            `Duplicate package registration ${directory}`,
        );
        registrations.set(directory, {repo, sha: commit.sha});
        repos.add(repo);
    }

    assert.ok(registrations.size > 0, 'Missing metapackage package registrations');
    return registrations;
}

module.exports = {packageRegistrationsAt};
