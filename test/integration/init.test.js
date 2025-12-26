const assert = require('node:assert');
const {join} = require('node:path');
const {createTempDir, removeTempDir} = require('../helpers/temp-dir');
const {readFile, readJson, fileExists} = require('../helpers/file-utils');
const {execInDir} = require('../helpers/exec');

const tests = [];

function test(name, fn) {
    tests.push({name, fn});
}

// Helper to get path to lint binary
function getLintBin() {
    return join(__dirname, '../../bin/lint.js');
}

// Helper to run lint command in a cross-platform way
async function runLintCommand(command, cwd) {
    const lintBin = getLintBin();
    const fullCommand = `node "${lintBin}" ${command}`.trim();
    
    return await execInDir(fullCommand, cwd);
}

test('should initialize lint in clean directory', async () => {
    let tempDir = await createTempDir();
    try {
        // Setup - create minimal package.json
        const {writeJson} = require('../helpers/file-utils');
        writeJson(tempDir, 'package.json', {
            name: 'test-package',
            version: '1.0.0',
        });

        // Execute
        await runLintCommand('init', tempDir);

        // Verify package.json scripts
        const pkg = readJson(tempDir, 'package.json');
        assert.strictEqual(pkg.scripts.lint, 'lint update && lint');
        assert.strictEqual(pkg.scripts['lint:fix'], 'lint update && lint fix');
        assert.strictEqual(pkg.scripts['pre-commit'], 'lint update && lint-staged');
        // husky init may modify prepare script, so just check it exists
        assert(pkg.scripts.prepare !== undefined, 'prepare script should exist');

        // Verify scaffolding files
        assert(fileExists(tempDir, '.eslintrc.js'), '.eslintrc.js should exist');
        assert(fileExists(tempDir, '.prettierrc.js'), '.prettierrc.js should exist');
        assert(fileExists(tempDir, '.stylelintrc.js'), '.stylelintrc.js should exist');
        assert(fileExists(tempDir, '.lintstagedrc.js'), '.lintstagedrc.js should exist');
        assert(fileExists(tempDir, '.husky/pre-commit'), '.husky/pre-commit should exist');

        // Verify ignore files
        assert(fileExists(tempDir, '.gitignore'), '.gitignore should exist');
        assert(fileExists(tempDir, '.eslintignore'), '.eslintignore should exist');
        assert(fileExists(tempDir, '.prettierignore'), '.prettierignore should exist');
        assert(fileExists(tempDir, '.stylelintignore'), '.stylelintignore should exist');
    } finally {
        await removeTempDir(tempDir);
    }
});

test('should not overwrite existing unrelated files', async () => {
    let tempDir = await createTempDir();
    try {
        // Setup - create package.json with existing scripts
        const {writeJson, writeFile} = require('../helpers/file-utils');
        writeJson(tempDir, 'package.json', {
            name: 'test-package',
            version: '1.0.0',
            scripts: {
                build: 'tsc',
                test: 'vitest',
            },
        });
        writeFile(tempDir, '.gitignore', '# Custom ignore\ncustom-file.txt\n');

        // Execute
        await runLintCommand('init', tempDir);

        // Verify existing files preserved
        const pkg = readJson(tempDir, 'package.json');
        assert.strictEqual(pkg.scripts.build, 'tsc');
        assert.strictEqual(pkg.scripts.test, 'vitest');

        const gitignore = readFile(tempDir, '.gitignore');
        assert(gitignore.includes('# Custom ignore'), 'Should preserve custom comments');
        assert(gitignore.includes('custom-file.txt'), 'Should preserve custom patterns');
    } finally {
        await removeTempDir(tempDir);
    }
});

test('should initialize Husky on init', async () => {
    let tempDir = await createTempDir();
    try {
        // Setup
        const {writeJson} = require('../helpers/file-utils');
        writeJson(tempDir, 'package.json', {
            name: 'test-package',
            version: '1.0.0',
        });

        // Execute
        await runLintCommand('init', tempDir);

        // Verify Husky was initialized
        assert(fileExists(tempDir, '.husky'), '.husky directory should exist');
        assert(fileExists(tempDir, '.husky/pre-commit'), '.husky/pre-commit should exist');

        const preCommit = readFile(tempDir, '.husky/pre-commit');
        assert(preCommit.includes('npm run pre-commit'), 'pre-commit hook should run npm run pre-commit');
    } finally {
        await removeTempDir(tempDir);
    }
});

test('should create all required ignore files with patterns', async () => {
    let tempDir = await createTempDir();
    try {
        // Setup
        const {writeJson} = require('../helpers/file-utils');
        writeJson(tempDir, 'package.json', {
            name: 'test-package',
            version: '1.0.0',
        });

        // Execute
        await runLintCommand('init', tempDir);

        // Verify ignore files contain required patterns
        const gitignore = readFile(tempDir, '.gitignore');
        assert(gitignore.includes('node_modules'), '.gitignore should contain node_modules');
        assert(gitignore.includes('.idea'), '.gitignore should contain .idea');

        const eslintignore = readFile(tempDir, '.eslintignore');
        assert(eslintignore.includes('node_modules'), '.eslintignore should contain node_modules');
    } finally {
        await removeTempDir(tempDir);
    }
});

module.exports = {tests};

