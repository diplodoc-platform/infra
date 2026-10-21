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
        assert.strictEqual(
            result.scripts.lock,
            'npm install --no-workspaces --package-lock-only --ignore-scripts',
        );
        assert.strictEqual(result.scripts.prepare, 'husky || true');
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

test('should preserve custom prepare hooks and remain idempotent', async () => {
    for (const prepare of [
        'node scripts/prepare.mjs',
        'node scripts/build-assets.js && husky',
        'husky && node scripts/generate.js',
    ]) {
        const tempDir = await createTempDir();
        try {
            writeJson(tempDir, 'package.json', {
                name: 'test-package',
                version: '1.0.0',
                scripts: {prepare},
            });

            const {stderr} = await runModifyPackage(tempDir);
            const first = readJson(tempDir, 'package.json');

            assert.strictEqual(first.scripts.prepare, prepare);
            assert(stderr.includes('WARNING') && stderr.includes('prepare'));

            await runModifyPackage(tempDir);
            assert.deepStrictEqual(readJson(tempDir, 'package.json'), first);
        } finally {
            await removeTempDir(tempDir);
        }
    }
});

test('should migrate only known standalone Husky prepare hooks', async () => {
    for (const prepare of ['husky', 'husky install', 'husky | exit 0', 'husky install || true']) {
        const tempDir = await createTempDir();
        try {
            writeJson(tempDir, 'package.json', {
                name: 'test-package',
                version: '1.0.0',
                scripts: {prepare},
            });

            await runModifyPackage(tempDir);
            assert.strictEqual(readJson(tempDir, 'package.json').scripts.prepare, 'husky || true');
        } finally {
            await removeTempDir(tempDir);
        }
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
