const assert = require('node:assert');
const {join} = require('node:path');
const {execSync} = require('node:child_process');
const {createTempDir, removeTempDir} = require('../helpers/temp-dir');
const {writeFile, readFile, writeJson, fileExists} = require('../helpers/file-utils');
const {mkdirSync} = require('node:fs');

const tests = [];

function test(name, fn) {
    tests.push({name, fn});
}

function getInfraBin() {
    return join(__dirname, '../../bin/infra.js');
}

function runInfra(args, cwd, env = {}) {
    const cmd = `node "${getInfraBin()}" ${args}`;
    return execSync(cmd, {
        cwd,
        encoding: 'utf8',
        stdio: 'pipe',
        env: {...process.env, ...env},
    });
}

// --- YAML parsing via js-yaml (tested indirectly through loadBlacklist/getRepoConfig) ---

test('should parse distribution.yml and list repos', async () => {
    let tempDir = await createTempDir();
    try {
        writeFile(
            tempDir,
            'distribution.yml',
            [
                'defaults:',
                '  auto_merge: false',
                '  exclude: []',
                '',
                'repos:',
                '  cli:',
                '    auto_merge: false',
                '    exclude:',
                '      - path: .github/workflows/release.yml',
                '        reason: "Custom release"',
                '  transform:',
                '    exclude: []',
                '  tabs-extension:',
                '    auto_merge: true',
                '',
            ].join('\n'),
        );

        const output = runInfra('blacklist show --repo cli --config ./distribution.yml', tempDir);
        assert(output.includes('release.yml'), 'Should show release.yml in blacklist');
        assert(output.includes('Custom release'), 'Should show reason');
    } finally {
        await removeTempDir(tempDir);
    }
});

test('should show empty blacklist for repo with no exclusions', async () => {
    let tempDir = await createTempDir();
    try {
        writeFile(
            tempDir,
            'distribution.yml',
            [
                'defaults:',
                '  auto_merge: true',
                '',
                'repos:',
                '  transform:',
                '    exclude: []',
            ].join('\n'),
        );

        const output = runInfra(
            'blacklist show --repo transform --config ./distribution.yml',
            tempDir,
        );
        assert(output.includes('No exclusions'), 'Should say no exclusions');
    } finally {
        await removeTempDir(tempDir);
    }
});

// --- Blacklist merge (central + local .infrarc.yml) ---

test('should merge central and local blacklists', async () => {
    let tempDir = await createTempDir();
    try {
        writeFile(
            tempDir,
            'distribution.yml',
            [
                'defaults:',
                '  auto_merge: false',
                '',
                'repos:',
                '  myrepo:',
                '    exclude:',
                '      - path: .github/workflows/release.yml',
                '        reason: "Central exclusion"',
            ].join('\n'),
        );

        const targetDir = join(tempDir, 'target');
        mkdirSync(targetDir, {recursive: true});
        writeJson(targetDir, 'package.json', {name: 'myrepo', version: '1.0.0'});
        writeFile(
            targetDir,
            '.infrarc.yml',
            ['exclude:', '  - path: .editorconfig', '    reason: "Local exclusion"'].join('\n'),
        );

        const output = runInfra(
            `blacklist show --repo myrepo --config ${join(tempDir, 'distribution.yml')}`,
            targetDir,
        );
        assert(output.includes('release.yml'), 'Should include central exclusion');
        assert(output.includes('.editorconfig'), 'Should include local exclusion');
    } finally {
        await removeTempDir(tempDir);
    }
});

// --- Expired exclusions (until field) ---

test('should filter out expired exclusions', async () => {
    let tempDir = await createTempDir();
    try {
        writeFile(
            tempDir,
            'distribution.yml',
            [
                'defaults:',
                '  auto_merge: false',
                '',
                'repos:',
                '  myrepo:',
                '    exclude:',
                '      - path: .github/workflows/old.yml',
                '        reason: "Expired"',
                '        until: "2020-01-01"',
                '      - path: .github/workflows/active.yml',
                '        reason: "Still active"',
                '        until: "2099-01-01"',
            ].join('\n'),
        );

        const output = runInfra(
            'blacklist show --repo myrepo --config ./distribution.yml',
            tempDir,
        );
        assert(!output.includes('old.yml'), 'Expired exclusion should not appear');
        assert(output.includes('active.yml'), 'Active exclusion should appear');
    } finally {
        await removeTempDir(tempDir);
    }
});

// --- infra sync --target --dry-run ---

test('should apply scaffolding in dry-run and show diff', async () => {
    let tempDir = await createTempDir();
    try {
        const targetDir = join(tempDir, 'target');
        mkdirSync(targetDir, {recursive: true});
        writeJson(targetDir, 'package.json', {name: 'test-pkg', version: '1.0.0'});

        // Init git repo so git diff works
        execSync(
            [
                'git init',
                'git config user.email "test@test.com"',
                'git config user.name "Test"',
                'git add -A',
                'git commit -m "init"',
            ].join(' && '),
            {cwd: targetDir, stdio: 'pipe', shell: true},
        );

        writeFile(
            tempDir,
            'distribution.yml',
            [
                'defaults:',
                '  auto_merge: false',
                '',
                'repos:',
                '  test-pkg:',
                '    exclude: []',
            ].join('\n'),
        );

        const output = runInfra(
            `sync --target ${targetDir} --repo test-pkg --dry-run --config ${join(tempDir, 'distribution.yml')}`,
            join(__dirname, '../..'),
        );

        assert(
            output.includes('Changes') || output.includes('test-pkg'),
            'Should show repo name or changes',
        );

        // Verify target was reverted (dry-run should not leave changes)
        const status = execSync('git status --porcelain', {
            cwd: targetDir,
            encoding: 'utf8',
        });
        assert.strictEqual(status.trim(), '', 'Dry-run should revert changes in target');
    } finally {
        await removeTempDir(tempDir);
    }
});

// --- infra sync --target (non-dry-run) applies scaffolding ---

test('should apply scaffolding to target directory', async () => {
    let tempDir = await createTempDir();
    try {
        const targetDir = join(tempDir, 'target');
        mkdirSync(targetDir, {recursive: true});
        writeJson(targetDir, 'package.json', {name: 'test-pkg', version: '1.0.0'});

        writeFile(
            tempDir,
            'distribution.yml',
            [
                'defaults:',
                '  auto_merge: false',
                '',
                'repos:',
                '  test-pkg:',
                '    exclude: []',
            ].join('\n'),
        );

        runInfra(
            `sync --target ${targetDir} --repo test-pkg --config ${join(tempDir, 'distribution.yml')}`,
            join(__dirname, '../..'),
        );

        assert(fileExists(targetDir, '.eslintrc.js'), '.eslintrc.js should be created');
        assert(fileExists(targetDir, '.prettierrc.js'), '.prettierrc.js should be created');
        assert(fileExists(targetDir, '.gitignore'), '.gitignore should be created');
    } finally {
        await removeTempDir(tempDir);
    }
});

// --- Blacklist respects exclusion during sync ---

test('should skip blacklisted files during sync', async () => {
    let tempDir = await createTempDir();
    try {
        const targetDir = join(tempDir, 'target');
        mkdirSync(targetDir, {recursive: true});
        writeJson(targetDir, 'package.json', {name: 'test-pkg', version: '1.0.0'});

        writeFile(
            tempDir,
            'distribution.yml',
            [
                'defaults:',
                '  auto_merge: false',
                '',
                'repos:',
                '  test-pkg:',
                '    exclude:',
                '      - .editorconfig',
            ].join('\n'),
        );

        runInfra(
            `sync --target ${targetDir} --repo test-pkg --config ${join(tempDir, 'distribution.yml')}`,
            join(__dirname, '../..'),
        );

        assert(fileExists(targetDir, '.eslintrc.js'), '.eslintrc.js should be created');
        assert(
            !fileExists(targetDir, '.editorconfig'),
            '.editorconfig should NOT be created (blacklisted)',
        );
    } finally {
        await removeTempDir(tempDir);
    }
});

// --- Help output ---

test('should show help when called with help command', async () => {
    const output = runInfra('help', process.cwd());
    assert(output.includes('infra'), 'Help should mention infra');
    assert(output.includes('sync'), 'Help should mention sync command');
    assert(output.includes('blacklist'), 'Help should mention blacklist command');
});

module.exports = {tests};
