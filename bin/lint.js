#!/usr/bin/env node

const {execSync} = require('node:child_process');
const {realpathSync} = require('node:fs');
const {dirname, join} = require('node:path');

// Resolve the actual path to this script, handling symlinks
const scriptPath = realpathSync(__filename);
const srcDir = dirname(dirname(scriptPath));
const binDir = join(srcDir, 'bin');

// Parse command line arguments
const args = process.argv.slice(2);
let fix = false;
let init = false;
let update = false;

for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
        case 'fix':
            fix = true;
            break;
        case 'init':
            init = true;
            break;
        case 'update':
            update = true;
            break;
    }
}

// Determine shell based on platform
const isWindows = process.platform === 'win32';
const shell = isWindows ? 'sh' : 'bash';

function execCommand(cmd, options = {}) {
    try {
        execSync(cmd, {
            stdio: 'inherit',
            shell: shell,
            cwd: process.cwd(),
            ...options,
        });
    } catch (error) {
        process.exit(error.status || 1);
    }
}

function hasStyleFiles() {
    try {
        const result = execSync(
            `find . -type f \\( -name '*.css' -o -name '*.scss' \\) | grep -vwFf .stylelintignore 2>/dev/null || true`,
            {shell: shell, cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe'},
        );
        return result && result.trim().length > 0;
    } catch {
        return false;
    }
}


if (init || update) {
    if (init) {
        console.log('[@diplodoc/lint] Extend package.json configuration');
        execCommand(`node "${join(srcDir, 'scripts/modify-package.js')}"`);

        execCommand(`"${join(binDir, 'husky')}" init`);
    }

    console.log('[@diplodoc/lint] Add initial lint configs');
    execCommand(`node "${join(srcDir, 'scripts/copy-scaffolding.js')}"`);

    console.log('[@diplodoc/lint] Extend .ignore configuration');
    execCommand(`node "${join(srcDir, 'scripts/modify-ignore.js')}"`);

    console.log('[@diplodoc/lint] Setup release-please configuration');
    execCommand(`node "${join(srcDir, 'scripts/modify-release-please.js')}"`);

    process.exit(0);
}

if (fix) {
    console.log('Run linters in fix mode');

    // Включаем legacy-режим ESLint (ESLint 8-style), чтобы:
    // - читался .eslintrc.js
    // - учитывался .eslintignore
    // Флаг ESLINT_USE_FLAT_CONFIG=false документирован в ESLint 9
    // как способ вернуться к старому поведению CLI.
    execCommand(
        `ESLINT_USE_FLAT_CONFIG=false "${join(
            binDir,
            'eslint',
        )}" . --ext .js,.mjs,.cjs,.jsx,.ts,.mts,.cts,.tsx --fix`,
    );
    execCommand(`"${join(binDir, 'prettier')}" --write '**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}'`);

    if (hasStyleFiles()) {
        execCommand(`"${join(binDir, 'stylelint')}" '**/*.{css,scss}' --fix`);
    }

    process.exit(0);
} else {
    console.log('Run linters');

    // То же самое для check-режима: используем legacy-режим ESLint,
    // передаём точку и расширения — ESLint сам находит файлы и
    // применяет .eslintignore.
    execCommand(
        `ESLINT_USE_FLAT_CONFIG=false "${join(
            binDir,
            'eslint',
        )}" . --ext .js,.mjs,.cjs,.jsx,.ts,.mts,.cts,.tsx`,
    );
    execCommand(`"${join(binDir, 'prettier')}" --check '**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}'`);

    if (hasStyleFiles()) {
        execCommand(`"${join(binDir, 'stylelint')}" '**/*.{css,scss}'`);
    }
}