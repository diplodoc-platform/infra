'use strict';

const assert = require('node:assert/strict');

const MAX_COHORT_SIZE = 40;
const DEPENDENCY_SECTIONS = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
];
const PACKAGE = /^(?:@[a-z0-9][a-z0-9-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;

/** Parse an operator-selected group; never combine unreviewed branches in one repository. */
function parseCohort(value) {
    const items = String(value || '')
        .split(',')
        .map((item) => item.trim());
    assert.ok(items.length > 0 && items.length <= MAX_COHORT_SIZE, 'Invalid cohort size');
    const requests = items.map((item) => {
        const match = /^([a-z0-9][a-z0-9-]*)#([1-9][0-9]*)$/.exec(item);
        assert.ok(match, 'Use comma-separated repo#PR identities');
        const number = Number(match[2]);
        assert.ok(Number.isSafeInteger(number), 'Invalid cohort PR number');
        assert.ok(
            !['cli', 'vsc'].includes(match[1]),
            'Direct CLI and VSC updates need their separate verification paths',
        );
        return {repo: match[1], number};
    });
    assert.equal(
        new Set(requests.map((item) => item.repo)).size,
        requests.length,
        'A cohort repeats a repository',
    );
    return requests.sort((a, b) => a.repo.localeCompare(b.repo));
}

/** Bind the manual mode to the identity; legacy wave identifiers remain unchanged. */
function cohortIdentity(plan) {
    return plan.schema === 2 ? {schema: 2, cohort: plan.cohort} : {};
}

function declares(manifest, name) {
    return DEPENDENCY_SECTIONS.some((section) => Object.hasOwn(manifest[section] || {}, name));
}

function validateCohort(plan) {
    const {cohort, selected, graph} = plan;
    assert.ok(cohort && typeof cohort === 'object' && !Array.isArray(cohort));
    assert.deepEqual(
        Object.keys(cohort).sort(),
        cohort.dependency ? ['dependency', 'requests'] : ['requests'],
    );
    const requests = parseCohort(
        cohort.requests.map(({repo, number}) => `${repo}#${number}`).join(','),
    );
    assert.deepEqual(cohort.requests, requests, 'Cohort requests must be complete and canonical');
    assert.deepEqual(
        selected.map(({repo, number}) => ({repo, number})),
        requests,
        'A manual cohort cannot be split or partially selected',
    );
    for (const node of selected) {
        assert.equal(node.risk, 'low', 'Only low-risk candidates may enter a cohort');
        assert.equal(typeof node.profile, 'string');
    }
    if (cohort.dependency) {
        const {name, version} = cohort.dependency;
        assert.deepEqual(Object.keys(cohort.dependency).sort(), ['name', 'version']);
        assert.match(name, PACKAGE);
        assert.match(version, VERSION, 'Missing stable exact cohort dependency version');
        const consumers = graph.filter(
            (node) => !['cli', 'vsc'].includes(node.repo) && declares(node.manifest, name),
        );
        assert.deepEqual(
            consumers.map((node) => node.repo).sort(),
            requests.map((node) => node.repo),
            'Include every registered consumer of the cohort dependency (CLI and VSC excluded)',
        );
    }
}

module.exports = {MAX_COHORT_SIZE, PACKAGE, parseCohort, cohortIdentity, validateCohort, declares};
