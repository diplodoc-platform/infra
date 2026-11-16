'use strict';

const assert = require('node:assert/strict');
const {declares} = require('./cohort');

/** A group updates one direct input; unrelated lock changes still pass the full policy check. */
function changedInput(before, after, oldLock, newLock) {
    const names = new Set();
    for (const section of [
        'dependencies',
        'devDependencies',
        'optionalDependencies',
        'peerDependencies',
    ]) {
        for (const name of Object.keys(after[section] || {})) {
            if (
                before[section]?.[name] !== after[section][name] ||
                oldLock.packages[`node_modules/${name}`]?.version !==
                    newLock.packages[`node_modules/${name}`]?.version
            )
                names.add(name);
        }
    }
    assert.equal(names.size, 1, 'Automatic groups require exactly one changed direct dependency');
    const [name] = names;
    const version = newLock.packages[`node_modules/${name}`]?.version;
    assert.match(
        version || '',
        /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/,
        'Automatic groups require one stable exact input version',
    );
    return {name, version};
}

/** Never certify a partial shared-dependency update, including when the allowlist is narrower. */
function automaticGroups(graph, inventory, inputs, repositories, baselines = new Map()) {
    const buckets = new Map();
    const excluded = [];
    for (const item of inventory) {
        const input = inputs.get(`${item.repo}#${item.number}`);
        if (!input) continue;
        const key = `${input.name}@${input.version}`;
        if (!buckets.has(key)) buckets.set(key, {dependency: input, candidates: []});
        buckets.get(key).candidates.push(item);
    }
    const groups = [];
    for (const {dependency, candidates} of buckets.values()) {
        const consumers = graph.filter(
            (node) =>
                !['cli', 'vsc'].includes(node.repo) && declares(node.manifest, dependency.name),
        );
        const baseline = [];
        const missing = consumers.filter((node) => {
            const matches = candidates.filter((item) => item.repo === node.repo);
            if (matches.length === 1 && repositories.includes(node.repo)) return false;
            const current = baselines.get(`${node.repo}:${dependency.name}`);
            if (
                matches.length === 0 &&
                current?.version === dependency.version &&
                current.sha === node.sha
            ) {
                baseline.push({repo: node.repo, sha: node.sha});
                return false;
            }
            return true;
        });
        if (missing.length) {
            excluded.push({
                dependency,
                reason: `Missing or ambiguous eligible PRs: ${missing
                    .map((node) => node.repo)
                    .sort()
                    .join(', ')}`,
            });
            continue;
        }
        const requests = candidates
            .map(({repo, number}) => ({repo, number}))
            .sort((a, b) => a.repo.localeCompare(b.repo));
        groups.push({
            dependency,
            requests,
            ...(baseline.length
                ? {baseline: baseline.sort((a, b) => a.repo.localeCompare(b.repo))}
                : {}),
            createdAt: candidates.map((item) => item.createdAt).sort()[0],
        });
    }
    groups.sort(
        (a, b) =>
            a.createdAt.localeCompare(b.createdAt) ||
            a.dependency.name.localeCompare(b.dependency.name) ||
            a.dependency.version.localeCompare(b.dependency.version),
    );
    return {groups, excluded};
}

module.exports = {changedInput, automaticGroups};
