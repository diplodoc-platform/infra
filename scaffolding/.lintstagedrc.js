module.exports = {
    '**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}': [
        'prettier --write',
        'eslint --max-warnings=0 --fix --no-warn-ignored',
    ],
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
