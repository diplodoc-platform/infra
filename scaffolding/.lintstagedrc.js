/* eslint-env node */
module.exports = {
    // Exclude config files and scripts from linting (they use CommonJS)
    '**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}': (filenames) => {
        // Filter out config files and scripts
        const configFiles = [
            '.lintstagedrc.js',
            '.eslintrc.js',
            '.prettierrc.js',
            '.stylelintrc.js',
        ];
        const filtered = filenames.filter(
            (f) =>
                !configFiles.some((config) => f.includes(config)) &&
                !f.includes('scripts/') &&
                !f.includes('test/'),
        );
        if (filtered.length === 0) {
            return [];
        }
        return ['prettier --write', 'eslint --max-warnings=0 --fix --no-warn-ignored'];
    },
    // Handle .lintstagedrc.js separately (only prettier, no eslint)
    '.lintstagedrc.js': ['prettier --write'],
    '**/*.{css,scss}': ['prettier --write', 'stylelint --fix'],
    '**/*.{json,yaml,yml,md}': ['prettier --write'],
    '**/*.{svg,svgx}': ['svgo'],
    // Run unit tests when test files or source files change
    '**/*.{ts,tsx}': (filenames) => {
        const testFiles = filenames.filter((f) => f.includes('.test.') || f.includes('.spec.'));
        const sourceFiles = filenames.filter(
            (f) => !f.includes('.test.') && !f.includes('.spec.') && f.includes('src/'),
        );
        const commands = [];
        // Run tests if test files or source files changed
        if (testFiles.length > 0 || sourceFiles.length > 0) {
            commands.push('npm test');
        }
        return commands;
    },
};
