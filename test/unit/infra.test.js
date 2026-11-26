const assert = require('node:assert');
const {join} = require('node:path');
const {execSync} = require('node:child_process');
const {createTempDir, removeTempDir} = require('../helpers/temp-dir');
const {writeFile, readFile, readJson, writeJson, fileExists} = require('../helpers/file-utils');
const {mkdirSync} = require('node:fs');
const {formatWorkflowTreeProposals} = require('../../scripts/preview-sync');
const reviewedWorkflowTrees = require('../../scripts/reviewed-workflow-trees.json');

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

test('distribution preview matches the workflow tree produced by sync on the enrolled repo', async () => {
    const tempDir = await createTempDir();
    try {
        const workflowDir = join(tempDir, '.github/workflows');
        mkdirSync(workflowDir, {recursive: true});
        writeJson(tempDir, 'package.json', {name: 'test-pkg', version: '1.0.0'});
        writeFile(workflowDir, 'coverage.yml', 'name: Original coverage\n');
        writeFile(workflowDir, 'security.yml', 'name: Custom security workflow\n');
        writeFile(tempDir, '.infrarc.yml', 'exclude:\n  - .github/workflows/security.yml\n');

        const git = (args) =>
            execSync(`git ${args}`, {cwd: tempDir, stdio: 'pipe', encoding: 'utf8'}).trim();
        git('init');
        git('add -A');
        git('-c user.name=Test -c user.email=fixture@example.invalid commit -m baseline');
        const before = git('rev-parse HEAD:.github/workflows');

        const preview = runInfra('sync --target . --repo components --dry-run', tempDir);
        assert.strictEqual(git('status --porcelain'), '');
        assert(preview.includes('.github/workflows/tests.yml'));

        runInfra('sync --target . --repo components', tempDir);
        git('add -A');
        const after = git(`rev-parse ${git('write-tree')}:.github/workflows`);
        assert.notStrictEqual(before, after);
        assert(fileExists(workflowDir, 'tests.yml'), 'a new workflow must be included');
        assert.strictEqual(
            readFile(workflowDir, 'security.yml'),
            'name: Custom security workflow\n',
        );
        assert(
            preview.includes(
                `| components | \`${before}\` | \`${after}\` | Review the current tree separately |`,
            ),
        );
    } finally {
        await removeTempDir(tempDir);
    }
});

test('workflow tree proposals retain registered trees and require a reviewed baseline', () => {
    const [componentsBefore, transformBefore] = [
        reviewedWorkflowTrees.components[0],
        reviewedWorkflowTrees.transform[0],
    ];
    const newTree = 'a'.repeat(40);
    const unknownTree = 'b'.repeat(40);
    const preview = (repoName, before, after) => ({repoName, workflowTree: {before, after}});
    const report = formatWorkflowTreeProposals([
        preview('components', componentsBefore, newTree),
        preview('transform', transformBefore, transformBefore),
        preview('algolia-extension', unknownTree, 'c'.repeat(40)),
    ]).join('\n');

    assert.deepStrictEqual(JSON.parse(report.split('```json\n')[1].split('\n```')[0]), {
        components: [...reviewedWorkflowTrees.components, newTree],
    });
    assert(!report.includes('| transform |'));
    assert(report.includes('Review the current tree separately'));
    assert.deepStrictEqual(
        formatWorkflowTreeProposals([preview('components', componentsBefore, componentsBefore)]),
        [],
    );
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
        writeJson(targetDir, 'package.json', {name: 'test-pkg', version: '1.0.0-beta.1'});
        writeJson(targetDir, '.release-please-manifest.json', {'.': '0.0.0'});
        writeFile(
            targetDir,
            '.infrarc.yml',
            ['exclude:', '  - path: .release-please-manifest.json', ''].join('\n'),
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
        assert.deepStrictEqual(readJson(targetDir, '.release-please-manifest.json'), {
            '.': '0.0.0',
        });
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
