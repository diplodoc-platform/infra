[![NPM version](https://img.shields.io/npm/v/@diplodoc/lint.svg?style=flat)](https://www.npmjs.org/package/@diplodoc/lint)

# @diplodoc/lint

Centralized linting and code formatting toolkit for Diplodoc projects. Combines ESLint, Prettier, and Stylelint configurations and automates their setup.

## Features

- **Automatic setup** — one command to initialize all tools
- **Automatic updates** — synchronizes configurations across packages
- **Metapackage and standalone support** — works as part of the metapackage and as a standalone npm package
- **Unified standards** — shared linting rules for all Diplodoc packages
- **Git hooks** — automatic pre-commit hook setup via Husky
- **TypeScript/JavaScript** — full support for both languages
- **CSS/SCSS** — style support via Stylelint

## Installation

```bash
npm install --save-dev @diplodoc/lint
```

## Quick Start

### 1. Initialization

Run the initialization command in your package root:

```bash
npx @diplodoc/lint init
```

This command will:

- Add necessary scripts to `package.json`
- Create configuration files (`.eslintrc.js`, `.prettierrc.js`, `.stylelintrc.js`)
- Set up Git hooks via Husky
- Update `.gitignore`, `.eslintignore`, `.prettierignore`, `.stylelintignore`

After initialization, commit the changes:

```bash
git add --all && git commit -m 'chore: init lint'
```

### 2. Usage

**Code checking:**

```bash
npm run lint
```

**Automatic fixing:**

```bash
npm run lint:fix
```

**Update configurations:**

```bash
npx @diplodoc/lint update
```

> **Note**: The `update` command runs automatically before each check (`npm run lint`), so configurations are always up-to-date.

## Commands

### `lint init`

Initializes linting in a package:

- Adds scripts to `package.json`:
  - `lint` — code checking
  - `lint:fix` — automatic fixing
  - `pre-commit` — pre-commit checking
  - `prepare` — Husky setup
- Copies configuration files from `scaffolding/`
- Sets up Husky for Git hooks
- Updates ignore files

### `lint update`

Updates configuration files to the latest versions:

- Updates `.eslintrc.js`, `.prettierrc.js`, `.stylelintrc.js`
- Updates ignore files with new patterns
- **Does not** re-initialize Husky
- **Does not** modify existing scripts in `package.json`

> **Important**: This command runs automatically before `lint` and `lint fix`, so configurations are always synchronized.

### `lint`

Checks code for rule compliance:

1. Automatically runs `lint update`
2. Runs ESLint for JavaScript/TypeScript files
3. Runs Prettier for formatting checks
4. Runs Stylelint for CSS/SCSS files (if present)

### `lint fix`

Automatically fixes found issues:

1. Automatically runs `lint update`
2. Runs ESLint with `--fix` flag
3. Runs Prettier with `--write` flag
4. Runs Stylelint with `--fix` flag (if CSS/SCSS files exist)

## Configuration

After initialization, the following files are created in the package root:

### `.eslintrc.js`

```javascript
module.exports = {
  root: true,
  extends: require.resolve('@diplodoc/lint/eslint-config'),
  parserOptions: {
    tsconfigRootDir: __dirname,
    project: true,
  },
};
```

Packages can extend the configuration at the `src/` level, but should not override base settings.

### `.prettierrc.js`

```javascript
module.exports = require('@diplodoc/lint/prettier-config');
```

### `.stylelintrc.js`

```javascript
module.exports = {
  extends: require.resolve('@diplodoc/lint/stylelint-config'),
};
```

Created only if CSS/SCSS files exist in the project.

## Supported Tools

### ESLint

- Configurations for TypeScript and JavaScript
- React support (via `eslint-config/client`)
- Node.js support (via `eslint-config/node`)
- Project-aware TypeScript parsing

### Prettier

- Unified formatting style for all packages
- Automatic formatting on save (via editor)

### Stylelint

- CSS and SCSS support
- Uses `@gravity-ui/stylelint-config` as base

### Husky

- Git hooks management
- Pre-commit hook runs `lint-staged`

### lint-staged

- Checks only changed files
- Fast pre-commit checking

## Metapackage vs Standalone Usage

The package works in two modes:

### In Metapackage (workspace mode)

When the package is installed as part of the metapackage via npm workspaces:

- Dependencies are resolved through shared `node_modules`
- Commands work through workspace links
- `package-lock.json` is managed at the metapackage level

### Standalone Mode

When the package is used as a standalone npm package:

- All dependencies are installed locally
- Commands work through `node_modules/.bin`
- For `package-lock.json` management, use `npm i --no-workspaces --package-lock-only`

Both modes are supported automatically — the package detects the context and works accordingly.

## package.json Scripts

After `lint init`, the following scripts are added to `package.json`:

```json
{
  "scripts": {
    "lint": "lint update && lint",
    "lint:fix": "lint update && lint fix",
    "pre-commit": "lint update && lint-staged",
    "prepare": "husky"
  }
}
```

- `lint` — code checking (with auto-update)
- `lint:fix` — automatic fixing (with auto-update)
- `pre-commit` — pre-commit checking (runs via Husky)
- `prepare` — Husky setup when installing dependencies

## Ignore Files

The package automatically updates the following ignore files:

- `.gitignore` — system files, dependencies, artifacts
- `.eslintignore` — system files, dependencies, artifacts, `test/`, `scripts/`
- `.prettierignore` — system files, dependencies, artifacts
- `.stylelintignore` — system files, dependencies, artifacts

Patterns are added automatically on `init` and `update`, duplicates are not created.

## Testing

The package includes a comprehensive test suite (34 tests):

```bash
# Run all tests
npm test

# Unit tests only
npm run test:unit

# Integration tests only
npm run test:integration
```

Tests use Node.js built-in `assert` module and require no external dependencies.

## Development

### Package Structure

```
@diplodoc/lint/
├── bin/              # Executable scripts
│   ├── lint         # Main script
│   ├── eslint       # ESLint proxy
│   ├── prettier     # Prettier proxy
│   └── ...
├── scripts/         # Helper scripts
│   ├── modify-package.js
│   └── modify-ignore.js
├── scaffolding/     # Configuration templates
│   ├── .eslintrc.js
│   ├── .prettierrc.js
│   └── ...
└── test/            # Tests
    ├── unit/
    ├── integration/
    └── helpers/
```

### Making Changes

1. Make code changes
2. Run tests: `npm test`
3. Check linting: `npm run lint`
4. Test in a test package: `npx @diplodoc/lint init`

## Important Notes

- **Auto-update**: The `lint update` command runs automatically on each `lint` execution, ensuring configuration synchronization
- **Backward compatibility**: When updating configs, backward compatibility is considered. Breaking changes require major version bumps
- **Package independence**: This package does not depend on other Diplodoc packages (except devops infrastructure)
- **Replaces deprecated packages**: This package replaces `@diplodoc/eslint-config` and `@diplodoc/prettier-config`. Do not use deprecated packages
- **Critical package**: This is a critical infrastructure dependency used by all Diplodoc packages. Changes should be thoroughly tested

## License

MIT
