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
