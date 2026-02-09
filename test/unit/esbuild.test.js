/**
 * Unit tests for @diplodoc/lint/esbuild subpath export.
 * Verifies that consumers can import the pre-bundled esbuild API and run builds.
 */

const assert = require('node:assert');
const {join} = require('node:path');
const {createTempDir, removeTempDir} = require('../helpers/temp-dir');
const {writeFile, readFile} = require('../helpers/file-utils');

// Resolves via test/node_modules/@diplodoc/lint (workspaces: ["../"] when tests run from test/)
const esbuildModule = require('@diplodoc/lint/esbuild');

const tests = [];

function test(name, fn) {
    tests.push({name, fn});
}

test('should export build function from @diplodoc/lint/esbuild', () => {
    assert.strictEqual(typeof esbuildModule.build, 'function', 'build must be a function');
});

test('should run a minimal build using imported build()', async () => {
    let tempDir;
    try {
        tempDir = await createTempDir();
        const entryPath = join(tempDir, 'entry.js');
        writeFile(tempDir, 'entry.js', 'export const x = 1;\n');

        const result = await esbuildModule.build({
            entryPoints: [entryPath],
            bundle: true,
            write: false,
            format: 'esm',
        });

        assert(result.outputFiles, 'outputFiles must be present');
        assert(result.outputFiles.length >= 1, 'at least one output file');
        const out = result.outputFiles[0];
        assert(out.text, 'output file must have text');
        assert(
            out.text.includes('x') || out.text.includes('1'),
            'bundled output should contain entry content',
        );
    } finally {
        if (tempDir) await removeTempDir(tempDir);
    }
});

test('should support build to file (like cut extension usage)', async () => {
    let tempDir;
    try {
        tempDir = await createTempDir();
        const entryPath = join(tempDir, 'in.js');
        const outPath = join(tempDir, 'out.js');
        writeFile(tempDir, 'in.js', 'console.log(42);\n');

        await esbuildModule.build({
            entryPoints: [entryPath],
            outfile: outPath,
            bundle: true,
        });

        const content = readFile(tempDir, 'out.js');
        assert(content, 'outfile must be written');
        assert(
            content.includes('42') || content.includes('console'),
            'output should contain bundled code',
        );
    } finally {
        if (tempDir) await removeTempDir(tempDir);
    }
});

module.exports = {tests};
