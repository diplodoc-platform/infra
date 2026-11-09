'use strict';

const assert = require('node:assert/strict');
const {read, write, fileAt, planId, validatePlan} = require('./candidate-train/common');

async function main() {
    const plan = read('selected/train-plan.json');
    const proposals = [
        {
            repo: 'transform',
            number: 1181,
            sha: 'd29edcb152df0005a99e3d07492ebd42909147d7',
            selected: true,
        },
        {
            repo: 'translation',
            number: 303,
            sha: 'fd0cd76c65de1c9e8fa22814a50285980174abee',
            selected: true,
        },
        {repo: 'cli', number: 2385, sha: '16b317fed5c48f56f91ad4ba6d110cfc7303facb'},
    ];

    for (const proposal of proposals) {
        const response = await fetch(
            `https://api.github.com/repos/diplodoc-platform/${proposal.repo}/pulls/${proposal.number}`,
            {
                headers: {Authorization: `Bearer ${process.env.GH_TOKEN}`},
            },
        );
        assert.ok(response.ok);
        const pull = await response.json();
        assert.equal(pull.head.sha, proposal.sha, 'Proposal head changed');
        const node = {
            repo: proposal.repo,
            sha: pull.head.sha,
            manifest: JSON.parse(await fileAt(proposal.repo, pull.head.sha, 'package.json')),
        };
        plan.graph[plan.graph.findIndex((item) => item.repo === node.repo)] = node;
        if (node.repo === 'cli') plan.cli = node;
        if (proposal.selected)
            plan.selected.push({
                ...node,
                number: proposal.number,
                baseSha: pull.base.sha,
                risk: 'low',
                profile: 'standard',
            });
    }

    // This is an explicitly requested integration batch of proposed baseline changes,
    // not a fresh Dependabot eligibility decision or a publishable morning selection.
    delete plan.selection;
    delete plan.inventory;
    delete plan.waves;
    plan.toolSha = process.env.GITHUB_SHA;
    plan.id = planId(plan);
    validatePlan(plan);
    write('proposed-plan.json', plan);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
