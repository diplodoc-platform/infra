const assert = require('node:assert/strict');
const {planId, validatePlan} = require('../../scripts/candidate-train/common');

const tests = [];
const test = (name, fn) => tests.push({name, fn});
const SHA = 'a'.repeat(40);

function fixture() {
    const source = {repo: 'utils', sha: SHA, manifest: {name: '@diplodoc/utils', version: '1.0.0'}};
    const cli = {repo: 'cli', sha: SHA, manifest: {name: '@diplodoc/cli', version: '1.0.0'}};
    const item = {
        repo: 'utils',
        number: 3,
        sha: SHA,
        baseSha: SHA,
        risk: 'low',
        profile: 'standard',
    };
    const plan = {
        schema: 1,
        toolSha: SHA,
        metapackageSha: SHA,
        cli,
        graph: [source, cli],
        selected: [{...source, ...item}],
        readyBy: '2026-10-28T05:00:00.000Z',
        selection: {wave: 1, totalWaves: 1, waveSize: 3, eligibleCount: 1, repositories: ['utils']},
        inventory: [item],
        waves: [[item]],
    };
    plan.id = planId(plan);

    return plan;
}

test('wave metadata retains schema 1 and the exact selected-source identity', () => {
    const plan = fixture();

    assert.equal(validatePlan(plan), plan);
    const id = plan.id;
    delete plan.selection;
    delete plan.inventory;
    delete plan.waves;
    assert.equal(planId(plan), id);
    assert.equal(validatePlan(plan), plan);
});

test('wave metadata rejects high risk, missing inventory and forged selected waves', () => {
    for (const mutate of [
        (plan) => {
            plan.inventory[0].risk = 'high';
        },
        (plan) => {
            delete plan.inventory;
        },
        (plan) => {
            plan.selection.wave = 2;
        },
        (plan) => {
            plan.waves[0] = [];
        },
        (plan) => {
            plan.selected[0].number = 4;
        },
    ]) {
        const plan = fixture();
        mutate(plan);
        plan.id = planId(plan);

        assert.throws(() => validatePlan(plan));
    }
});

test('two source PRs from one repository cannot enter the same wave', () => {
    const plan = fixture();
    const other = {...plan.inventory[0], number: 4};
    plan.inventory.push(other);
    plan.waves[0].push(other);
    plan.selection.eligibleCount++;

    assert.throws(() => validatePlan(plan), /wave repeats a repository/);
});

module.exports = {tests};
