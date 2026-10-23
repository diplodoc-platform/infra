const assert = require('node:assert');
const {mkdtempSync, readFileSync, rmSync, existsSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {parseFlags, writeOutput} = require('../../scripts/cli-options');

const tests = [
    {
        name: 'shared flags retain boolean switches, values and last repeated value',
        fn: () => {
            assert.deepStrictEqual(
                parseFlags([
                    'ignored',
                    '--dry-run',
                    '--repo',
                    'tabs-extension',
                    '--repo',
                    'transform',
                ]),
                {'dry-run': true, repo: 'transform'},
            );
            assert.deepStrictEqual(parseFlags([]), {});
        },
    },
    {
        name: 'shared report output creates parents only for an explicit destination',
        fn: () => {
            const temporary = mkdtempSync(join(tmpdir(), 'infra-cli-output-'));
            try {
                const output = join(temporary, 'reports', 'audit.json');
                writeOutput(null, 'ignored');
                assert.strictEqual(existsSync(output), false);
                writeOutput(output, '{"errors":[]}');
                assert.strictEqual(readFileSync(output, 'utf8'), '{"errors":[]}');
            } finally {
                rmSync(temporary, {recursive: true, force: true});
            }
        },
    },
];

module.exports = {tests};
