const assert = require('node:assert/strict');
const {
    preparationStatus,
    renderPreparationStatus,
} = require('../../scripts/candidate-train/open-candidate');

const tests = [];
const test = (name, fn) => tests.push({name, fn});

test('open candidates block preparation without writing, merging or claiming success', async () => {
    const status = await preparationStatus(async (route) => {
        assert.equal(
            route,
            '/repos/diplodoc-platform/cli/pulls?state=open&base=master&per_page=100&page=1',
        );

        return [
            {number: 2360, head: {ref: 'codex/dependency-candidate-old'}},
            {number: 2400, head: {ref: 'ordinary-feature'}},
        ];
    });

    assert.equal(status.available, false);
    assert.deepEqual(status.candidates, [
        {number: 2360, url: 'https://github.com/diplodoc-platform/cli/pull/2360'},
    ]);
    assert.match(renderPreparationStatus(status), /blocked before build/);
    assert.match(renderPreparationStatus(status), /not successful verification/);
});

test('no open candidate permits preparation and malformed API data fails closed', async () => {
    const status = await preparationStatus(async () => []);

    assert.equal(status.available, true);
    await assert.rejects(() => preparationStatus(async () => null), /complete API array/);
    await assert.rejects(
        () => preparationStatus(async () => [{head: {ref: 'codex/dependency-candidate-bad'}}]),
        /Invalid open candidate/,
    );
});

module.exports = {tests};
