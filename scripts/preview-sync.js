'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const reviewedWorkflowTrees = require('./reviewed-workflow-trees.json');

const workflowDirectory = '.github/workflows';

function previewGitEnv() {
    return Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
    );
}

/** Preview the exact dirty tree in a disposable copy; never mutate the source. */
function previewLocalSync(target, apply, report) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-sync-preview-'));
    const copy = path.join(root, 'target');
    try {
        fs.cpSync(target, copy, {
            recursive: true,
            filter: (source) => {
                if (['.git', 'node_modules'].includes(path.basename(source))) return false;
                if (fs.lstatSync(source).isSymbolicLink())
                    throw new Error(`Cannot preview symlink: ${source}`);
                return true;
            },
        });
        const env = previewGitEnv();
        const hooks = path.join(root, 'empty-hooks');
        fs.mkdirSync(hooks);
        const git = (args) =>
            execFileSync('git', ['-c', `core.hooksPath=${hooks}`, ...args], {
                cwd: copy,
                stdio: 'pipe',
                env,
            });
        git(['init', '--quiet']);
        git(['add', '--force', '--all']);
        git([
            '-c',
            'user.name=Infra Preview',
            '-c',
            'user.email=infra-preview@example.invalid',
            'commit',
            '--quiet',
            '--allow-empty',
            '-m',
            'Preview input',
        ]);
        apply(copy);
        // Include newly generated scaffolding in the preview diff.
        git(['add', '--intent-to-add', '--force', '--all']);
        return report(copy);
    } finally {
        fs.rmSync(root, {recursive: true, force: true});
    }
}

function previewWorkflowTree(target, repo) {
    if (!Object.hasOwn(reviewedWorkflowTrees, repo)) return;

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-workflow-index-'));
    try {
        const env = {...previewGitEnv(), GIT_INDEX_FILE: path.join(tempDir, 'index')};
        const git = (args) =>
            execFileSync('git', args, {cwd: target, env, encoding: 'utf8', stdio: 'pipe'}).trim();
        const readTree = (revision) => {
            const entry = git(['ls-tree', revision, '--', workflowDirectory]);
            return /^040000 tree ([a-f0-9]{40})\t\.github\/workflows$/.exec(entry)?.[1];
        };
        const before = readTree('HEAD');
        if (!before) throw new Error(`${repo}: missing baseline workflow tree`);

        // Stage exactly what distribution would commit, using a disposable index.
        git(['read-tree', 'HEAD']);
        git(['add', '--all', '--', workflowDirectory]);
        const after = readTree(git(['write-tree']));
        if (!after) throw new Error(`${repo}: distribution removed the workflow tree`);

        return {before, after};
    } finally {
        fs.rmSync(tempDir, {recursive: true, force: true});
    }
}

function formatWorkflowTreeProposals(reports) {
    const changes = [];
    const additions = {};
    for (const {repoName, workflowTree} of reports) {
        if (!workflowTree) continue;
        const {before, after} = workflowTree;
        const approved = reviewedWorkflowTrees[repoName];
        const registered = approved.includes(after);
        if (before === after && registered) continue;

        let status = 'Already approved';
        if (!registered && !approved.includes(before)) {
            status = 'Review the current tree separately';
        } else if (!registered) {
            status = 'Review proposed addition';
            additions[repoName] = [...approved, after];
        }
        changes.push(`| ${repoName} | \`${before}\` | \`${after}\` | ${status} |`);
    }
    if (!changes.length) return [];

    const lines = [
        '## Candidate train workflow trees',
        '',
        '| Repository | Current tree | After distribution | Status |',
        '| --- | --- | --- | --- |',
        ...changes,
        '',
    ];
    if (Object.keys(additions).length) {
        lines.push(
            'After reviewing the workflow changes, update these entries in `scripts/reviewed-workflow-trees.json` before merging the distribution PRs.',
            '',
            '```json',
            JSON.stringify(additions, null, 4),
            '```',
            '',
        );
    }
    return lines;
}

module.exports = {previewLocalSync, previewWorkflowTree, formatWorkflowTreeProposals};
