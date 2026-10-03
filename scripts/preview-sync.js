'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

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
        const env = Object.fromEntries(
            Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
        );
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

module.exports = {previewLocalSync};
