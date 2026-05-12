const {join} = require('node:path');
const {readFileSync, writeFileSync, existsSync} = require('node:fs');

const SYSTEM = ['.idea', '.vscode', '.history', '.env', '.DS_Store'];
const ARTIFACTS = ['/lib', '/dist', '/build', '/cache', '/coverage', '/external'];
const INSTALL = ['node_modules'];

const ignores = {
    '.gitignore': [...SYSTEM, ...INSTALL, ...ARTIFACTS],
    '.eslintignore': [
        ...SYSTEM,
        ...INSTALL,
        ...ARTIFACTS,
        // Config files use CommonJS
        '.lintstagedrc.js',
        '.eslintrc.js',
        '.prettierrc.js',
        '.stylelintrc.js',
        // Build scripts that use newer syntax not yet supported by ESLint parser
        'esbuild/**/*.mjs',
    ],
    '.prettierignore': [...SYSTEM, ...INSTALL, ...ARTIFACTS],
    '.stylelintignore': [...SYSTEM, ...INSTALL, ...ARTIFACTS],
};

const targetDir = process.env.INFRA_TARGET_DIR || process.cwd();

for (const [file, list] of Object.entries(ignores)) {
    const filename = join(targetDir, file);

    let source;
    try {
        source = readFileSync(filename, 'utf8').split('\n');
    } catch {
        source = [];
    }

    console.log('[@diplodoc/infra]', 'Update', file);

    for (const rule of list) {
        add(source, rule);
    }

    writeFileSync(filename, source.join('\n'), 'utf8');
}

function add(source, ignore) {
    if (!source.includes(ignore)) {
        source.push(ignore);
        console.log('[@diplodoc/infra]', '=> Add', ignore);
    }
}
