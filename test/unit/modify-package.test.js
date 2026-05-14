const assert = require('node:assert');
const {join} = require('node:path');
const {createTempDir, removeTempDir} = require('../helpers/temp-dir');
const {readJson, writeJson} = require('../helpers/file-utils');
const {exec} = require('node:child_process');
const {promisify} = require('node:util');

const execAsync = promisify(exec);

const scriptPath = join(__dirname, '../../scripts/modify-package.js');

async function runModifyPackage(cwd) {
    const {stdout, stderr} = await execAsync(`node ${scriptPath}`, {cwd});
    return {stdout, stderr};
}

const tests = [];

function test(name, fn) {
    tests.push({name, fn});
}

test('should add scripts to empty package.json', async () => {
    let tempDir = await createTempDir();
    try {
        // Setup
        const pkg = {name: 'test-package', version: '1.0.0'};
        writeJson(tempDir, 'package.json', pkg);

        // Execute
        await runModifyPackage(tempDir);

        // Verify
        const result = readJson(tempDir, 'package.json');
        assert.strictEqual(result.scripts.lint, 'lint');
        assert.strictEqual(result.scripts['lint:fix'], 'lint fix');
        assert.strictEqual(result.scripts['pre-commit'], 'lint-staged');
        // prepare script should be set (husky || true is forced)
        assert(result.scripts.prepare !== undefined, 'prepare script should exist');
        assert(result.scripts.prepare.includes('husky'), 'prepare script should contain husky');
    } finally {
        await removeTempDir(tempDir);
    }
});

test('should not overwrite existing scripts with same implementation', async () => {
    let tempDir = await createTempDir();
    try {
        // Setup
        const pkg = {
            name: 'test-package',
            version: '1.0.0',
            scripts: {
                lint: 'lint',
                build: 'echo build',
            },
        };
        writeJson(tempDir, 'package.json', pkg);

        // Execute
        await runModifyPackage(tempDir);

        // Verify
        const result = readJson(tempDir, 'package.json');
        assert.strictEqual(result.scripts.lint, 'lint');
        assert.strictEqual(result.scripts.build, 'echo build'); // Preserved
        assert.strictEqual(result.scripts['lint:fix'], 'lint fix'); // Added
    } finally {
        await removeTempDir(tempDir);
    }
});

test('should preserve customized script and warn (not throw)', async () => {
    let tempDir = await createTempDir();
    try {
        // Setup
        const pkg = {
            name: 'test-package',
            version: '1.0.0',
            scripts: {
                lint: 'different command',
            },
        };
        writeJson(tempDir, 'package.json', pkg);

        // Execute — should not throw, just warn
        const {stderr} = await runModifyPackage(tempDir);

        // Verify the customized value is preserved and a warning is printed
        const result = readJson(tempDir, 'package.json');
        assert.strictEqual(
            result.scripts.lint,
            'different command',
            'customized script should be preserved',
        );
        assert(
            stderr.includes('WARNING') && stderr.includes('lint'),
            `expected a WARNING about "lint" script in stderr, got: ${stderr}`,
        );
    } finally {
        await removeTempDir(tempDir);
    }
});

test('should migrate legacy "lint update && lint" → "lint"', async () => {
    let tempDir = await createTempDir();
    try {
        // Setup: legacy pull-distribution scripts
        const pkg = {
            name: 'test-package',
            version: '1.0.0',
            scripts: {
                lint: 'lint update && lint',
                'lint:fix': 'lint update && lint fix',
                'pre-commit': 'lint update && lint-staged',
            },
        };
        writeJson(tempDir, 'package.json', pkg);

        // Execute
        const {stdout} = await runModifyPackage(tempDir);

        // Verify legacy values are migrated to canonical ones
        const result = readJson(tempDir, 'package.json');
        assert.strictEqual(result.scripts.lint, 'lint');
        assert.strictEqual(result.scripts['lint:fix'], 'lint fix');
        assert.strictEqual(result.scripts['pre-commit'], 'lint-staged');
        assert(stdout.includes('Migrate'), `expected Migrate log in stdout, got: ${stdout}`);
    } finally {
        await removeTempDir(tempDir);
    }
});

test('should force update prepare script', async () => {
    let tempDir = await createTempDir();
    try {
        // Setup
        const pkg = {
            name: 'test-package',
            version: '1.0.0',
            scripts: {
                prepare: 'old prepare script',
            },
        };
        writeJson(tempDir, 'package.json', pkg);

        // Execute
        await runModifyPackage(tempDir);

        // Verify
        const result = readJson(tempDir, 'package.json');
        // prepare script should be force updated (husky || true)
        assert(result.scripts.prepare !== undefined, 'prepare script should exist');
        assert(result.scripts.prepare.includes('husky'), 'prepare script should contain husky');
    } finally {
        await removeTempDir(tempDir);
    }
});

test('should preserve unrelated scripts', async () => {
    let tempDir = await createTempDir();
    try {
        // Setup
        const pkg = {
            name: 'test-package',
            version: '1.0.0',
            scripts: {
                build: 'tsc',
                test: 'vitest',
                start: 'node index.js',
            },
        };
        writeJson(tempDir, 'package.json', pkg);

        // Execute
        await runModifyPackage(tempDir);

        // Verify
        const result = readJson(tempDir, 'package.json');
        assert.strictEqual(result.scripts.build, 'tsc');
        assert.strictEqual(result.scripts.test, 'vitest');
        assert.strictEqual(result.scripts.start, 'node index.js');
        assert.strictEqual(result.scripts.lint, 'lint');
    } finally {
        await removeTempDir(tempDir);
    }
});

test('should throw error when package.json is invalid JSON', async () => {
    let tempDir = await createTempDir();
    try {
        // Setup
        const {writeFileSync} = require('node:fs');
        writeFileSync(join(tempDir, 'package.json'), '{ invalid json }', 'utf8');

        // Execute & Verify
        await assert.rejects(
            async () => {
                await runModifyPackage(tempDir);
            },
            (error) => {
                return error.message.includes('Unable to modify');
            },
        );
    } finally {
        await removeTempDir(tempDir);
    }
});

test('should throw error when package.json does not exist', async () => {
    let tempDir = await createTempDir();
    try {
        // Execute & Verify
        await assert.rejects(
            async () => {
                await runModifyPackage(tempDir);
            },
            (error) => {
                return error.code === 'ENOENT' || error.message.includes('Unable to modify');
            },
        );
    } finally {
        await removeTempDir(tempDir);
    }
});

test('should create scripts field if it does not exist', async () => {
    let tempDir = await createTempDir();
    try {
        // Setup
        const pkg = {name: 'test-package', version: '1.0.0'};
        writeJson(tempDir, 'package.json', pkg);

        // Execute
        await runModifyPackage(tempDir);

        // Verify
        const result = readJson(tempDir, 'package.json');
        assert(result.scripts !== undefined);
        assert.strictEqual(typeof result.scripts, 'object');
    } finally {
        await removeTempDir(tempDir);
    }
});

module.exports = {tests};
