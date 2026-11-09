'use strict';

const assert = require('node:assert/strict');
const {read, write, fileAt, planId, validatePlan} = require('./candidate-train/common');

async function main() {
    const plan = read('selected/train-plan.json');
    const revisions = JSON.parse(process.env.PROPOSED_REVISIONS);
    for (const [repo, sha] of Object.entries(revisions)) {
        assert.match(sha, /^[a-f0-9]{40}$/);
        const node = {repo, sha, manifest: JSON.parse(await fileAt(repo, sha, 'package.json'))};
        plan.graph[plan.graph.findIndex((item) => item.repo === repo)] = node;
        if (repo === 'cli') plan.cli = node;
    }
    plan.toolSha = process.env.GITHUB_SHA;
    plan.id = planId(plan);
    validatePlan(plan);
    write('proposed-plan.json', plan);
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
