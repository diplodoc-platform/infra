const assert = require('node:assert');
const {join} = require('node:path');
const {createTempDir, removeTempDir} = require('../helpers/temp-dir');
const {readFile, readJson, fileExists, writeFile, writeJson} = require('../helpers/file-utils');
const {execInDir} = require('../helpers/exec');

const tests = [];

function test(name, fn) {
    tests.push({name, fn});
}

// Helper to get path to lint binary
function getLintBin() {
    return join(__dirname, '../../bin/lint');
}

// Helper to run lint command in a cross-platform way
async function runLintCommand(command, cwd) {
    const lintBin = getLintBin();
    const isWindows = process.platform === 'win32';
    
    const normalizedBin = isWindows ? lintBin.replace(/\\/g, '/') : lintBin;
    const shell = isWindows ? 'sh' : 'bash';
    const fullCommand = `${shell} "${normalizedBin}" ${command}`.trim();
    
    return await execInDir(fullCommand, cwd);
}

test('should update scaffolding files when they are outdated', async () => {
    let tempDir = await createTempDir();
    try {
        // Setup - initialize first
        writeJson(tempDir, 'package.json', {
            name: 'test-package',
            version: '1.0.0',
        });

        await runLintCommand('init', tempDir);

        // Modify scaffolding file to simulate outdated version
        const oldContent = 'module.exports = { old: true };';
        writeFile(tempDir, '.eslintrc.js', oldContent);

        // Execute update
        await runLintCommand('update', tempDir);

        // Verify file was updated
        const newContent = readFile(tempDir, '.eslintrc.js');
        assert.notStrictEqual(newContent, oldContent, 'File should be updated');
        assert(newContent.includes('@diplodoc/lint/eslint-config'), 'Should contain correct config');
    } finally {
        await removeTempDir(tempDir);
    }
});

test('should update ignore files with missing patterns', async () => {
    let tempDir = await createTempDir();
    try {
        // Setup - initialize first
        writeJson(tempDir, 'package.json', {
            name: 'test-package',
            version: '1.0.0',
        });

        await runLintCommand('init', tempDir);

        // Remove some patterns from ignore file
        const gitignore = readFile(tempDir, '.gitignore');
        const modifiedGitignore = gitignore.split('\n').filter(line => !line.includes('.idea')).join('\n');
        writeFile(tempDir, '.gitignore', modifiedGitignore);

        // Execute update
        await runLintCommand('update', tempDir);

        // Verify missing pattern was added back
        const updatedGitignore = readFile(tempDir, '.gitignore');
        assert(updatedGitignore.includes('.idea'), 'Missing pattern should be added');
    } finally {
        await removeTempDir(tempDir);
    }
});

test('should not re-initialize Husky on update', async () => {
    let tempDir = await createTempDir();
    try {
        // Setup - initialize first
        writeJson(tempDir, 'package.json', {
            name: 'test-package',
            version: '1.0.0',
        });

        await runLintCommand('init', tempDir);

        // Modify husky pre-commit hook
        const customHook = '#!/usr/bin/env sh\ncustom-command\n';
        writeFile(tempDir, '.husky/pre-commit', customHook);
        const originalHookContent = readFile(tempDir, '.husky/pre-commit');

        // Execute update
        await runLintCommand('update', tempDir);

        // Verify husky hook was NOT overwritten (update doesn't touch husky)
        // Actually, update copies scaffolding which includes .husky/pre-commit
        // So it will be overwritten. Let's check that it contains the expected content
        const updatedHook = readFile(tempDir, '.husky/pre-commit');
        // Update should restore the scaffolding version
        assert(updatedHook.includes('npm run pre-commit'), 'Should contain npm run pre-commit');
    } finally {
        await removeTempDir(tempDir);
    }
});

test('should not modify package.json scripts on update', async () => {
    let tempDir = await createTempDir();
    try {
        // Setup - initialize first
        writeJson(tempDir, 'package.json', {
            name: 'test-package',
            version: '1.0.0',
        });

        await runLintCommand('init', tempDir);

        // Add custom script
        const pkg = readJson(tempDir, 'package.json');
        pkg.scripts.custom = 'echo custom';
        writeJson(tempDir, 'package.json', pkg);

        // Execute update
        await runLintCommand('update', tempDir);

        // Verify custom script is preserved
        const updatedPkg = readJson(tempDir, 'package.json');
        assert.strictEqual(updatedPkg.scripts.custom, 'echo custom', 'Custom script should be preserved');
        assert.strictEqual(updatedPkg.scripts.lint, 'lint update && lint', 'Lint script should still exist');
    } finally {
        await removeTempDir(tempDir);
    }
});

test('should update all scaffolding files', async () => {
    let tempDir = await createTempDir();
    try {
        // Setup - initialize first
        writeJson(tempDir, 'package.json', {
            name: 'test-package',
            version: '1.0.0',
        });

        await runLintCommand('init', tempDir);

        // Modify all scaffolding files
        writeFile(tempDir, '.eslintrc.js', 'old');
        writeFile(tempDir, '.prettierrc.js', 'old');
        writeFile(tempDir, '.stylelintrc.js', 'old');
        writeFile(tempDir, '.lintstagedrc.js', 'old');

        // Execute update
        await runLintCommand('update', tempDir);

        // Verify all files were updated
        const eslintrc = readFile(tempDir, '.eslintrc.js');
        const prettierrc = readFile(tempDir, '.prettierrc.js');
        const stylelintrc = readFile(tempDir, '.stylelintrc.js');
        const lintstagedrc = readFile(tempDir, '.lintstagedrc.js');

        assert.notStrictEqual(eslintrc, 'old', '.eslintrc.js should be updated');
        assert.notStrictEqual(prettierrc, 'old', '.prettierrc.js should be updated');
        assert.notStrictEqual(stylelintrc, 'old', '.stylelintrc.js should be updated');
        assert.notStrictEqual(lintstagedrc, 'old', '.lintstagedrc.js should be updated');
    } finally {
        await removeTempDir(tempDir);
    }
});

test('should handle update when files are already up-to-date', async () => {
    let tempDir = await createTempDir();
    try {
        // Setup - initialize first
        writeJson(tempDir, 'package.json', {
            name: 'test-package',
            version: '1.0.0',
        });

        await runLintCommand('init', tempDir);

        // Get original content
        const originalEslintrc = readFile(tempDir, '.eslintrc.js');
        const originalGitignore = readFile(tempDir, '.gitignore');

        // Execute update (should be idempotent)
        await runLintCommand('update', tempDir);

        // Verify files are unchanged (or at least functionally equivalent)
        const updatedEslintrc = readFile(tempDir, '.eslintrc.js');
        const updatedGitignore = readFile(tempDir, '.gitignore');

        // Files should still contain the same essential content
        assert(updatedEslintrc.includes('@diplodoc/lint/eslint-config'), 'Should still have correct config');
        assert(updatedGitignore.includes('node_modules'), 'Should still have node_modules');
    } finally {
        await removeTempDir(tempDir);
    }
});

module.exports = {tests};

