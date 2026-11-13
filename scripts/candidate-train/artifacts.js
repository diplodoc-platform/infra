'use strict';

const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {buildOrder} = require('./common');
const {buildEdges, CLI_BUNDLED_INPUTS, MODELED_RUNTIME_INPUTS, optInExtension} = require('./model');

/** Runtime artifacts exclude packages used only to compile another package's assets. */
function runtimeArtifacts(plan) {
    const byName = new Map(plan.graph.map((node) => [node.manifest.name, node]));
    const optIns = plan.selected
        .filter((node) => optInExtension(node.manifest.name)?.repo === node.repo)
        .map((node) => node.manifest.name);
    const reachable = new Set();
    const visit = (name) => {
        if (reachable.has(name)) return;
        reachable.add(name);
        const node = byName.get(name);
        const names = Object.keys({
            ...node.manifest.dependencies,
            ...node.manifest.optionalDependencies,
            ...node.manifest.peerDependencies,
        });
        const modeled = MODELED_RUNTIME_INPUTS.find((item) => item.repo === node.repo);
        names.push(
            ...(modeled?.dependencies || []).filter(
                (name) => node.manifest.devDependencies?.[name],
            ),
        );
        if (node.repo === 'cli')
            names.push(
                ...CLI_BUNDLED_INPUTS.filter((input) => node.manifest.devDependencies?.[input]),
                ...optIns,
            );
        for (const child of names) if (child !== '@diplodoc/cli' && byName.has(child)) visit(child);
    };
    visit('@diplodoc/cli');
    return buildOrder(plan.graph, plan.selected).filter(
        (node) => node.repo !== 'cli' && reachable.has(node.manifest.name),
    );
}

/** Independently derivable build receipts; these are not CLI-installed runtime evidence. */
function buildReceipts(plan, locks, hashes) {
    const built = new Map();
    const edges = buildEdges(plan.graph, plan.selected);
    return buildOrder(plan.graph, plan.selected)
        .filter((node) => node.repo !== 'cli')
        .map((node) => {
            const inputs = edges(node)
                .filter((name) => built.has(name))
                .map((name) => built.get(name))
                .sort((a, b) => a.repo.localeCompare(b.repo));
            const lock = locks.get(node.repo);
            assert.ok(lock, 'Missing canonical build lock');
            const archiveSha256 = hashes.get(node.repo);
            assert.match(archiveSha256, /^[a-f0-9]{64}$/);
            const receipt = {
                scope: 'package-build',
                repo: node.repo,
                sourceSha: node.sha,
                sourceLockSha256: createHash('sha256').update(JSON.stringify(lock)).digest('hex'),
                archiveSha256,
                inputs,
            };
            if (plan.cohort?.dependency && plan.selected.some((item) => item.repo === node.repo)) {
                const {name, version} = plan.cohort.dependency;
                assert.equal(lock.packages[`node_modules/${name}`]?.version, version);
                receipt.cohortInput = {name, version};
            }
            built.set(node.manifest.name, {repo: node.repo, sourceSha: node.sha, archiveSha256});
            return receipt;
        });
}

module.exports = {runtimeArtifacts, buildReceipts};
