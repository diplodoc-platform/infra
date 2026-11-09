'use strict';

const assert = require('node:assert/strict');
const {read, write, fileAt, planId, validatePlan} = require('./candidate-train/common');

async function main() {
    const plan = read('selected/train-plan.json');
    const proposals = [
        {
            repo: 'transform',
            number: 1181,
            sha: '79cc434ce56f8ae4bcfd19ad4eef06d0d6812d99',
            selected: true,
        },
        {
            repo: 'translation',
            number: 303,
            sha: '2de01f937f6d6fc2f748f713eff6d234a9d0a48a',
            selected: true,
        },
        {repo: 'cli', number: 2385, sha: 'ab168e54e4ad0d3201d2a6fb756764c02cf4a78a'},
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
