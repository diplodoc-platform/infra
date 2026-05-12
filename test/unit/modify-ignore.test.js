const assert = require('node:assert');
const {join} = require('node:path');
const {createTempDir, removeTempDir} = require('../helpers/temp-dir');
const {readFile, writeFile} = require('../helpers/file-utils');
const {exec} = require('node:child_process');
const {promisify} = require('node:util');

const execAsync = promisify(exec);

const scriptPath = join(__dirname, '../../scripts/modify-ignore.js');

async function runModifyIgnore(cwd) {
    const {stdout, stderr} = await execAsync(`node ${scriptPath}`, {cwd});
    return {stdout, stderr};
}

const tests = [];

function test(name, fn) {
    tests.push({name, fn});
}

test('should create ignore files if they do not exist', async () => {
    let tempDir = await createTempDir();
    try {
        // Execute
        await runModifyIgnore(tempDir);

        // Verify
        const gitignore = readFile(tempDir, '.gitignore');
        const eslintignore = readFile(tempDir, '.eslintignore');
        const prettierignore = readFile(tempDir, '.prettierignore');
        const stylelintignore = readFile(tempDir, '.stylelintignore');

        assert(gitignore !== null, '.gitignore should be created');
        assert(eslintignore !== null, '.eslintignore should be created');
        assert(prettierignore !== null, '.prettierignore should be created');
        assert(stylelintignore !== null, '.stylelintignore should be created');
    } finally {
        await removeTempDir(tempDir);
    }
});

test('should add patterns to empty ignore files', async () => {
    let tempDir = await createTempDir();
    try {
        // Setup - create empty files
        writeFile(tempDir, '.gitignore', '');
        writeFile(tempDir, '.eslintignore', '');

        // Execute
        await runModifyIgnore(tempDir);

        // Verify
        const gitignore = readFile(tempDir, '.gitignore');
        const eslintignore = readFile(tempDir, '.eslintignore');

        assert(gitignore.includes('.idea'), 'Should contain .idea');
        assert(gitignore.includes('node_modules'), 'Should contain node_modules');
        assert(gitignore.includes('/lib'), 'Should contain /lib');

        assert(eslintignore.includes('.idea'), 'Should contain .idea');
        assert(eslintignore.includes('node_modules'), 'Should contain node_modules');
    } finally {
        await removeTempDir(tempDir);
    }
});

test('should add missing patterns to existing ignore files', async () => {
    let tempDir = await createTempDir();
    try {
        // Setup - create files with some existing content
        writeFile(tempDir, '.gitignore', '# Existing\n*.log\n');
        writeFile(tempDir, '.eslintignore', 'custom-pattern\n');

        // Execute
        await runModifyIgnore(tempDir);

        // Verify
        const gitignore = readFile(tempDir, '.gitignore');
        const eslintignore = readFile(tempDir, '.eslintignore');

        // Should preserve existing content
        assert(gitignore.includes('# Existing'), 'Should preserve existing comments');
        assert(gitignore.includes('*.log'), 'Should preserve existing patterns');
        assert(eslintignore.includes('custom-pattern'), 'Should preserve existing patterns');

        // Should add new patterns
        assert(gitignore.includes('.idea'), 'Should add .idea');
        assert(gitignore.includes('node_modules'), 'Should add node_modules');
        assert(eslintignore.includes('.idea'), 'Should add .idea');
    } finally {
        await removeTempDir(tempDir);
    }
});

test('should not add duplicate patterns', async () => {
    let tempDir = await createTempDir();
    try {
        // Setup - create file with some patterns that will be added
        writeFile(tempDir, '.gitignore', 'node_modules\n.idea\n');

        // Execute
        await runModifyIgnore(tempDir);

        // Verify
        const gitignore = readFile(tempDir, '.gitignore');
        const lines = gitignore.split('\n').filter((line) => line.trim() !== '');

        // Count occurrences
        const nodeModulesCount = lines.filter((line) => line === 'node_modules').length;
        const ideaCount = lines.filter((line) => line === '.idea').length;

        assert.strictEqual(nodeModulesCount, 1, 'node_modules should appear only once');
        assert.strictEqual(ideaCount, 1, '.idea should appear only once');
    } finally {
        await removeTempDir(tempDir);
    }
});

test('should add all required patterns to .gitignore', async () => {
    let tempDir = await createTempDir();
    try {
        // Execute
        await runModifyIgnore(tempDir);

        // Verify
        const gitignore = readFile(tempDir, '.gitignore');
        const patterns = [
            '.idea',
            '.vscode',
            '.history',
            '.env',
            '.DS_Store',
            'node_modules',
            '/lib',
            '/dist',
            '/build',
            '/cache',
            '/coverage',
            '/external',
        ];

        for (const pattern of patterns) {
            assert(gitignore.includes(pattern), `.gitignore should contain ${pattern}`);
        }
    } finally {
        await removeTempDir(tempDir);
    }
});

test('should add all required patterns to .eslintignore', async () => {
    let tempDir = await createTempDir();
    try {
        // Execute
        await runModifyIgnore(tempDir);

        // Verify
        const eslintignore = readFile(tempDir, '.eslintignore');
        const patterns = ['.idea', 'node_modules', '/lib', '/dist', '/build'];

        for (const pattern of patterns) {
            assert(eslintignore.includes(pattern), `.eslintignore should contain ${pattern}`);
        }
    } finally {
        await removeTempDir(tempDir);
    }
});

test('should add all required patterns to .prettierignore', async () => {
    let tempDir = await createTempDir();
    try {
        // Execute
        await runModifyIgnore(tempDir);

        // Verify
        const prettierignore = readFile(tempDir, '.prettierignore');
        const patterns = ['.idea', 'node_modules', '/lib', '/dist'];

        for (const pattern of patterns) {
            assert(prettierignore.includes(pattern), `.prettierignore should contain ${pattern}`);
        }
    } finally {
        await removeTempDir(tempDir);
    }
});

test('should add all required patterns to .stylelintignore', async () => {
    let tempDir = await createTempDir();
    try {
        // Execute
        await runModifyIgnore(tempDir);

        // Verify
        const stylelintignore = readFile(tempDir, '.stylelintignore');
        const patterns = ['.idea', 'node_modules', '/lib', '/dist'];

        for (const pattern of patterns) {
            assert(stylelintignore.includes(pattern), `.stylelintignore should contain ${pattern}`);
        }
    } finally {
        await removeTempDir(tempDir);
    }
});

test('should handle files with trailing newlines', async () => {
    let tempDir = await createTempDir();
    try {
        // Setup - file with trailing newline
        writeFile(tempDir, '.gitignore', 'existing-pattern\n\n');

        // Execute
        await runModifyIgnore(tempDir);

        // Verify
        const gitignore = readFile(tempDir, '.gitignore');
        assert(gitignore.includes('existing-pattern'), 'Should preserve existing pattern');
        assert(gitignore.includes('.idea'), 'Should add new patterns');
    } finally {
        await removeTempDir(tempDir);
    }
});

module.exports = {tests};
