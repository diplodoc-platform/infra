'use strict';

const assert = require('node:assert/strict');
const {buildOrder} = require('./common');

const WAVE_SIZE = 3;
const INVENTORY_LIMIT = 2000;

/** Resolve the registered packages that can participate in the CLI candidate. */
function repositoryTargets(graph, requested) {
    const supported = [];
    const unsupported = [];

    for (const node of graph) {
        if (node.repo === 'cli') continue;

        try {
            buildOrder(graph, [node]);
            supported.push(node.repo);
        } catch (error) {
            if (!error.message.includes('is not in the CLI build graph')) throw error;
            unsupported.push({repo: node.repo, reason: 'Package is outside the CLI build graph'});
        }
    }

    supported.sort();
    unsupported.sort((left, right) => left.repo.localeCompare(right.repo));

    if (requested[0] === 'all') return {repositories: supported, unsupported};

    for (const repo of requested) {
        assert.ok(
            graph.some((node) => node.repo === repo),
            `Unregistered target ${repo}`,
        );
        assert.ok(supported.includes(repo), `${repo} is not in the CLI build graph`);
    }

    return {repositories: [...requested].sort(), unsupported};
}

/** Partition one frozen inventory; each wave is an independent candidate. */
function candidateWaves(candidates) {
    assert.ok(candidates.length <= INVENTORY_LIMIT, 'Candidate inventory exceeds the size limit');
    const pending = [...candidates].sort(
        (left, right) =>
            left.createdAt.localeCompare(right.createdAt) ||
            left.repo.localeCompare(right.repo) ||
            left.number - right.number,
    );
    const identities = pending.map((item) => `${item.repo}#${item.number}`);
    assert.equal(new Set(identities).size, identities.length, 'Duplicate source PR in inventory');
    const waves = [];

    while (pending.length) {
        const wave = [];
        const repositories = new Set();

        for (let index = 0; index < pending.length && wave.length < WAVE_SIZE; ) {
            const item = pending[index];

            if (repositories.has(item.repo)) {
                index++;
                continue;
            }

            wave.push(item);
            repositories.add(item.repo);
            pending.splice(index, 1);
        }

        waves.push(wave);
    }

    return waves;
}

/** Keep the full inventory report small; selected manifests stay in the plan. */
function candidateIdentity({repo, number, sha, baseSha, risk, profile}) {
    return {repo, number, sha, baseSha, risk, profile};
}

module.exports = {WAVE_SIZE, INVENTORY_LIMIT, repositoryTargets, candidateWaves, candidateIdentity};
