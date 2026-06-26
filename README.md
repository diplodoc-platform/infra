**english** | [русский](https://github.com/diplodoc-platform/infra/blob/master/README.ru.md)

---

[![NPM version](https://img.shields.io/npm/v/@diplodoc/infra.svg?style=flat)](https://www.npmjs.org/package/@diplodoc/infra)

# @diplodoc/infra

Central infrastructure package for the Diplodoc platform. Manages linting configurations, CI workflows, Git hooks, and automated distribution of infrastructure updates across 30+ repositories.

> **Migration note**: This package was formerly named `@diplodoc/lint`. It also replaces the deprecated `@diplodoc/eslint-config` and `@diplodoc/prettier-config` packages.

## Features

- **Unified linting** — shared ESLint, Prettier, and Stylelint configurations
- **Automated distribution** — infrastructure updates delivered via PRs to all repos on release
- **Blacklist support** — per-repo exclusions for selective scaffolding
- **Pre-release testing** — scaffolding changes tested against real packages before release
- **Auto-merge** — PRs auto-merge when CI passes (configurable per repo)
- **Git hooks** — pre-commit and commit-msg hooks via Husky
- **Pre-bundled esbuild** — shared esbuild version via `@diplodoc/infra/esbuild`

## Installation

```bash
npm install --save-dev @diplodoc/infra
```

## Quick Start

### First-Time Setup

```bash
npx @diplodoc/infra init
```

This will:

- Add `lint`, `lint:fix`, `pre-commit`, `prepare` scripts to `package.json`
- Create configuration files (`.eslintrc.js`, `.prettierrc.js`, `.stylelintrc.js`, etc.)
- Set up Git hooks via Husky
- Update ignore files (`.gitignore`, `.eslintignore`, etc.)
- Create GitHub Actions workflow templates

### Linting

```bash
npm run lint        # Check for issues
npm run lint:fix    # Auto-fix issues
```

### Manual Infrastructure Update

```bash
npx @diplodoc/infra update
```

> **Note**: In normal workflow, infrastructure updates are delivered automatically via PRs from the infra repo. Manual updates are for development and debugging only.

## How Distribution Works

Infrastructure updates follow a **push model**:

1. Changes are made to scaffolding files in this repo
2. `integration-test.yml` tests changes against 3 reference packages before merge
3. On release, `distribute-infra.yml` creates PRs in all target repositories
4. PRs are auto-merged when CI passes (unless disabled for the repo)

```
@diplodoc/infra release
        │
        ▼
distribute-infra.yml
        │
        ├─→ cli (PR, manual review)
        ├─→ transform (PR, manual review)
        ├─→ cut-extension (PR, auto-merge)
        ├─→ tabs-extension (PR, auto-merge)
        └─→ ... 26 more repos
```

### Blacklist (Exclusions)

Some files can be excluded from distribution for specific repos:

**Centralized** — in `distribution.yml` (this repo):

```yaml
repos:
  cli:
    auto_merge: false
    exclude:
      - path: .github/workflows/tests.yml
        reason: 'Custom E2E workflow'
      - path: .github/workflows/release.yml
        reason: 'Node.js 24 migration in progress'
        until: '2026-07-01'
```

**Per-repo** — in `.infrarc.yml` (target repo root):

```yaml
exclude:
  - path: .github/workflows/tests.yml
    reason: 'Custom matrix build'
  - .editorconfig
```

Both lists are merged during distribution. Entries with expired `until` dates are ignored.

## Supported Tools

### ESLint

- Configurations for TypeScript and JavaScript
- React support (via `eslint-config/client`)
- Node.js support (via `eslint-config/node`)
- Project-aware TypeScript parsing
- Uses `ESLINT_USE_FLAT_CONFIG=false` (legacy ESLint 8-style config)

### Prettier

- Unified formatting style for all packages
- Uses `@gravity-ui/prettier-config` as base

### Stylelint

- CSS and SCSS support
- Uses `@gravity-ui/stylelint-config` as base

### Husky

- Git hooks management
- Pre-commit hook runs `lint-staged`

### lint-staged

- Checks only changed files
- Fast pre-commit checking
- Runs unit tests when test/source files change

### SonarCloud

Scaffolding provides optional SonarCloud integration:

- **`sonar-project.properties`** — copied with `{{PACKAGE_NAME}}` substitution (scope removed, e.g. `@diplodoc/foo` → `foo`)
- **`.github/workflows/sonarcloud.yml`** — runs analysis on push/PR to `master`/`main` (only when `test:coverage` script exists)
- **`.github/workflows/coverage.yml`** — optional, runs `test:coverage` when script exists

To enable SonarCloud for a repository:

1. Add the repository in [SonarCloud](https://sonarcloud.io) (organization `diplodoc-platform`)
2. Add the **SONAR_TOKEN** secret in GitHub repo settings
3. Optionally add a `test:coverage` script (e.g. `vitest run --coverage`)

## Commands

### `lint` (linting only)

| Command       | Description                                     |
| ------------- | ----------------------------------------------- |
| `lint`        | Run ESLint + Prettier + Stylelint in check mode |
| `lint fix`    | Run all linters with auto-fix                   |
| `lint init`   | Initialize infrastructure in current package    |
| `lint update` | Update scaffolding files locally                |

### `infra` (infrastructure management)

| Command                           | Description                            |
| --------------------------------- | -------------------------------------- |
| `infra sync --all`                | Create PRs in all target repos         |
| `infra sync --repo cli`           | Create PR in a specific repo           |
| `infra sync --dry-run --all`      | Preview changes without creating PRs   |
| `infra sync --target ./path`      | Apply scaffolding to a local directory |
| `infra blacklist show --repo cli` | Show exclusions for a repo             |
| `infra blacklist audit`           | List expired exclusions                |

## Configuration

### ⚠️ Important: Auto-Generated Files

The following configuration files are **automatically generated and updated** by `@diplodoc/infra`:

- `.eslintrc.js`, `.prettierrc.js`, `.stylelintrc.js`, `.lintstagedrc.js`
- `.eslintignore`, `.prettierignore`, `.stylelintignore`
- `.gitignore` (patterns are added automatically)
- `.github/workflows/*.yml`

**⚠️ DO NOT EDIT THESE FILES MANUALLY** — any changes will be overwritten on the next infrastructure update.

If you need to customize:

1. Check if the customization can be done via package-level overrides (e.g. `src/.eslintrc.js`)
2. If not, add the file to blacklist (`.infrarc.yml`) and manage it manually
3. Or open a PR to `@diplodoc/infra` to add the feature to templates

### Configuration File Examples

**`.eslintrc.js`**:

```javascript
module.exports = {
  root: true,
  extends: require.resolve('@diplodoc/infra/eslint-config'),
  parserOptions: {
    tsconfigRootDir: __dirname,
    project: true,
  },
};
```

Packages can extend the configuration at `src/` level, but should not override base settings.

**`.prettierrc.js`**:

```javascript
module.exports = require('@diplodoc/infra/prettier-config');
```

**`.stylelintrc.js`**:

```javascript
module.exports = {
  extends: require.resolve('@diplodoc/infra/stylelint-config'),
};
```

### Auto-Generated Files

The following files are created/updated by `infra init` and `infra update`:

| File                       | Purpose                                                 | Editable?                                 |
| -------------------------- | ------------------------------------------------------- | ----------------------------------------- |
| `.eslintrc.js`             | ESLint config (extends `@diplodoc/infra/eslint-config`) | No — use `src/.eslintrc.js` for overrides |
| `.prettierrc.js`           | Prettier config                                         | No                                        |
| `.stylelintrc.js`          | Stylelint config                                        | No                                        |
| `.lintstagedrc.js`         | lint-staged config                                      | No                                        |
| `.editorconfig`            | Editor settings                                         | No                                        |
| `.husky/pre-commit`        | Pre-commit hook                                         | No                                        |
| `.husky/commit-msg`        | Commit message validation                               | No                                        |
| `.github/workflows/*.yml`  | CI workflows                                            | No — use blacklist to exclude             |
| `sonar-project.properties` | SonarCloud config                                       | No                                        |

**Do not edit these files manually** — changes will be overwritten on the next infrastructure update.

### Package Scripts

After `infra init`, the following scripts are added:

```json
{
  "lint": "lint",
  "lint:fix": "lint fix",
  "pre-commit": "lint-staged",
  "prepare": "husky || true"
}
```

### Exports

```javascript
// ESLint configurations
require('@diplodoc/infra/eslint-config'); // Common
require('@diplodoc/infra/eslint-config/client'); // Client-side (React)
require('@diplodoc/infra/eslint-config/node'); // Node.js

// Prettier
require('@diplodoc/infra/prettier-config');

// Stylelint
require('@diplodoc/infra/stylelint-config');

// Pre-bundled esbuild
import {build} from '@diplodoc/infra/esbuild';
```

### Pre-bundled esbuild

Use `@diplodoc/infra/esbuild` instead of adding `esbuild` as a direct dependency. This ensures all packages share the same version and native bindings:

```javascript
import {build} from '@diplodoc/infra/esbuild';

build({
  entryPoints: ['src/plugin/index.ts'],
  outfile: 'build/plugin/index.js',
  bundle: true,
  platform: 'node',
  packages: 'external',
});
```

## distribution.yml Reference

```yaml
defaults:
  auto_merge: true # PRs auto-merge when CI passes
  exclude: [] # Global exclusions (applied to all repos)

repos:
  cli:
    auto_merge: false # Manual review required
    exclude:
      - .github/workflows/tests.yml # Exact path
      - .github/workflows/*.yml # Glob pattern
      - path: .github/workflows/release.yml # Extended format
        reason: 'Custom release process' # Why excluded
        until: '2026-07-01' # Auto-expires
```

## Metapackage vs Standalone Usage

The package works in two modes:

### In Metapackage (workspace mode)

When installed as part of the Diplodoc metapackage via npm workspaces:

- Located at `devops/infra/` in the metapackage
- Dependencies are resolved through shared `node_modules`
- Commands work through workspace links
- `package-lock.json` is managed at the metapackage level

### Standalone Mode

When used as an independent npm package:

- All dependencies are installed locally
- Commands work through `node_modules/.bin`
- For `package-lock.json` management, use `npm i --no-workspaces --package-lock-only`

Both modes are supported automatically — path resolution uses `require.resolve()` which works in both contexts.

## Development

### Package Structure

```
@diplodoc/infra/
├── bin/
│   ├── lint.js          # Linting CLI
│   ├── infra.js         # Infrastructure CLI
│   ├── eslint           # ESLint proxy
│   ├── prettier         # Prettier proxy
│   └── ...
├── scripts/
│   ├── copy-scaffolding.js    # Scaffolding with blacklist support
│   ├── modify-package.js      # Adds scripts to consumer package.json
│   ├── modify-ignore.js       # Updates .ignore files
│   └── modify-release-please.js
├── scaffolding/         # Template files distributed to consumers
├── distribution.yml     # Repo list + blacklist + auto-merge config
├── *-config.js          # Lint configuration files
└── test/
    ├── unit/
    ├── integration/
    └── helpers/
```

### Testing

```bash
npm test                  # All tests
npm run test:unit         # Unit tests only
npm run test:integration  # Integration tests only
```

### CI Workflows (in this repo)

- **`integration-test.yml`** — On PR: applies scaffolding to cli, transform, cut-extension; runs their full CI. Blocks merge if anything breaks.
- **`distribute-infra.yml`** — On release or manual trigger: creates PRs in all target repos with `max-parallel: 5`.

## Migration from @diplodoc/lint

For consumer packages:

1. Replace `@diplodoc/lint` with `@diplodoc/infra` in `devDependencies`
2. Run `npx @diplodoc/infra init` (or wait for the automated PR)
3. The auto-generated config files will be updated to reference `@diplodoc/infra/*`

For import paths:

- `@diplodoc/lint/eslint-config` → `@diplodoc/infra/eslint-config`
- `@diplodoc/lint/prettier-config` → `@diplodoc/infra/prettier-config`
- `@diplodoc/lint/stylelint-config` → `@diplodoc/infra/stylelint-config`
- `@diplodoc/lint/esbuild` → `@diplodoc/infra/esbuild`

## License

MIT
