module.exports = {
    root: true,
    extends: require.resolve('@diplodoc/lint/eslint-config'),
    parserOptions: {
        tsconfigRootDir: __dirname,
        project: true,
    },
    // ignorePatterns is needed because ESLint may not read .eslintignore
    // when using glob patterns in command line
    ignorePatterns: [
        'lib/**',
        'dist/**',
        'build/**',
        'coverage/**',
        'node_modules/**',
        'test/**',
        'scripts/**',
        '.lintstagedrc.js',
        '.eslintrc.js',
        '.prettierrc.js',
        '.stylelintrc.js',
    ],
};
