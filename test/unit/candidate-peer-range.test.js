const assert = require('node:assert/strict');
const {satisfiesStable} = require('../../scripts/candidate-train/peer-range');
module.exports.tests = [
    {
        name: 'frozen peer compatibility accepts bounded stable npm ranges and fails closed',
        fn() {
            for (const range of ['^18.0.0', '>=18 <20', '18.x', '18', '~18.3', '^17 || ^18', '*'])
                assert.equal(satisfiesStable('18.3.1', range), true, range);
            for (const range of [
                '^19',
                '<18',
                '~18.2.0',
                '18.2',
                'latest',
                'workspace:*',
                '18.0 - 19.0',
                '>=18 ||',
                '^18.0.0-beta',
            ])
                assert.equal(satisfiesStable('18.3.1', range), false, range);
            assert.equal(satisfiesStable('0.2.4', '^0.2.3'), true);
            assert.equal(satisfiesStable('0.3.0', '^0.2.3'), false);
            assert.equal(satisfiesStable('0.0.4', '^0.0.3'), false);
            assert.equal(satisfiesStable('18.3.1-beta', '*'), false);
        },
    },
];
