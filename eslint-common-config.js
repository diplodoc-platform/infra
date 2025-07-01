module.exports = {
    root: true,
    extends: [
        '@gravity-ui/eslint-config',
        process.env.npm_command && '@gravity-ui/eslint-config/prettier',
    ].filter(Boolean),
    parserOptions: {
        requireConfigFile: false,
        babelOptions: {
            plugins: [
                '@babel/plugin-syntax-import-assertions'
            ]
        }
    },
    overrides: [{
        files: [
            '.eslintrc.js',
            '.prettierrc.js',
            '.stylelintrc.js',
            '.lintstagedrc.js',
            'jest.config.js',
        ],
        env: {
            node: true,
        },
    }],
    rules: {
        'callback-return': 'off',
        'consistent-return': 'off',
        'no-implicit-globals': 'off',
        'no-param-reassign': 'off',
        'no-shadow': 'off',
        '@typescript-eslint/no-shadow': 'off',
        'import/no-extraneous-dependencies': 'error',
        'import/order': [
            'error',
            {
                alphabetize: {
                    order: 'ignore',
                    orderImportKind: 'asc'
                },
                'newlines-between': 'always',
                groups: ['type', ['builtin', 'external'], 'internal', 'parent', 'sibling', 'index'],
                warnOnUnassignedImports: true,
                pathGroups: [
                    {
                        pattern: '*.s?css$',
                        group: 'index',
                    },
                ],
            },
        ],
        "@typescript-eslint/consistent-type-imports": "error",
    },
};
