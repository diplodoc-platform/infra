const {join} = require('node:path');
const {readFileSync, writeFileSync, existsSync} = require('node:fs');

const SYSTEM = [
    '.idea',
    '.vscode',
    '.history',
    '.env',
    '.DS_Store',
];
const ARTIFACTS = [
    '/lib',
    '/dist',
    '/build',
    '/cache',
    '/coverage',
    '/external',
];
const INSTALL = [
    'node_modules',
];

// Check if this is the @diplodoc/lint package itself
function isLintPackage() {
    try {
        const packageJsonPath = join(process.cwd(), 'package.json');
        if (!existsSync(packageJsonPath)) {
            return false;
        }
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
        return packageJson.name === '@diplodoc/lint';
    } catch {
        return false;
    }
}

const isLintPkg = isLintPackage();

const ignores = {
    '.gitignore': [
        ...SYSTEM,
        ...INSTALL,
        ...ARTIFACTS,
    ],
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
        // For @diplodoc/lint package itself: bin/ and scripts/ contain internal scripts
        ...(isLintPkg ? ['bin/', 'scripts/'] : []),
    ],
    '.prettierignore': [
        ...SYSTEM,
        ...INSTALL,
        ...ARTIFACTS,
    ],
    '.stylelintignore': [
        ...SYSTEM,
        ...INSTALL,
        ...ARTIFACTS,
    ]
};

for (const [file, list] of Object.entries(ignores)) {
    const filename = join(process.cwd(), file);

    let source;
    try {
        source = readFileSync(filename, 'utf8').split('\n');
    } catch {
        source = [];
    }

    console.log('[@diplodoc/lint]', 'Update', file);

    for (const rule of list) {
        add(source, rule);
    }

    writeFileSync(filename, source.join('\n'), 'utf8');
}

function add(source, ignore) {
    if (!source.includes(ignore)) {
        source.push(ignore);
        console.log('[@diplodoc/lint]', '=> Add', ignore);
    }
}