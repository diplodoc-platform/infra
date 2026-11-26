'use strict';

const assert = require('node:assert/strict');
const {REPO} = require('./common');
const {repositoryTargets} = require('./waves');

const EXCLUDED = new Set(['cli', 'vsc', 'infra']);

function approvalRepositories(value, graph) {
    if (!value?.trim()) return new Set();

    const names = value.split(',').map((repo) => repo.trim());
    assert.ok(
        names.every((repo) => REPO.test(repo)),
        'Configure a pilot repository list or all',
    );
    assert.ok(!names.includes('all') || names.length === 1, 'all cannot be combined with names');

    const repositories = names[0] === 'all' ? repositoryTargets(graph, names).repositories : names;
    return new Set(repositories.filter((repo) => !EXCLUDED.has(repo)));
}

module.exports = {approvalRepositories};
