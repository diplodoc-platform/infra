# AGENTS.md

This file contains instructions for AI agents working with the `@diplodoc/lint` project.

## Project Description

`@diplodoc/lint` is a DevOps infrastructure package that provides linting utilities for all Diplodoc platform packages. It consolidates ESLint, Prettier, Stylelint, Husky, and lint-staged configurations into a single package, replacing the deprecated `@diplodoc/eslint-config` and `@diplodoc/prettier-config` packages.

**Key Features**:
- Unified linting infrastructure for all platform packages
- Automatic infrastructure updates on each run
- Pre-commit hooks via Husky
- Multiple ESLint configurations (common, client, node)
- Prettier and Stylelint configurations
- SVGO integration for SVG optimization

## Project Structure

### Main Directories

- `bin/` — executable scripts (see detailed description below)
- `scaffolding/` — template files copied during `init`/`update`
  - `.eslintrc.js` — ESLint configuration template
  - `.prettierrc.js` — Prettier configuration template
  - `.stylelintrc.js` — Stylelint configuration template
  - `.lintstagedrc.js` — lint-staged configuration template
  - `.husky/pre-commit` — Husky pre-commit hook template
- `scripts/` — helper scripts for package.json and .ignore file modification
  - `modify-package.js` — adds lint scripts to package.json
  - `modify-ignore.js` — updates .ignore files with standard patterns
- `test/` — package tests

### Configuration Files

- `eslint-common-config.js` — common ESLint configuration
- `eslint-client-config.js` — client-side ESLint configuration
- `eslint-node-config.js` — Node.js ESLint configuration
- `eslint-prettier-config.js` — ESLint config with Prettier integration
- `prettier-common-config.js` — Prettier configuration
- `stylelint-common-config.js` — Stylelint configuration

## Tech Stack

- **Language**: JavaScript (Node.js)
- **Runtime**: Node.js >=11.5.1 (npm requirement)
- **Testing**: Custom test setup in `test/` directory
- **Build**: No build step required (pure JavaScript package)

## Usage Modes

This package can be used in two different contexts:

### 1. As Part of Metapackage (Workspace Mode)

When `@diplodoc/lint` is part of the Diplodoc metapackage:
- Located at `devops/lint/` in the metapackage
- Linked via npm workspaces
- Dependencies are shared from metapackage root `node_modules`
- Can be developed alongside other packages
- Changes are immediately available to other packages via workspace linking

**Development in Metapackage**:
```bash
# From metapackage root
cd devops/lint
npm install  # Uses workspace dependencies

# Or from metapackage root
npx nx build @diplodoc/lint  # If configured in nx
```

**Using from Other Packages in Metapackage**:
- Other packages can use `@diplodoc/lint` directly
- Workspace linking ensures local version is used
- No need to publish to npm for local development

### 2. As Standalone Package (Independent Mode)

When `@diplodoc/lint` is used as a standalone npm package:
- Installed via `npm install --save-dev @diplodoc/lint`
- Has its own `node_modules` with all dependencies
- Can be cloned and developed independently
- Must be published to npm for others to use

**Development Standalone**:
```bash
# Clone the repository
git clone git@github.com:diplodoc-platform/lint.git
cd lint
npm install  # Installs all dependencies locally

# Run tests
npm test
```

**Using in External Projects**:
```bash
# Install from npm
npm install --save-dev @diplodoc/lint

# Initialize
npx @diplodoc/lint init

# Use
npm run lint
```

### Important Considerations

**Path Resolution**:
- In metapackage: Scripts resolve paths relative to metapackage structure
- Standalone: Scripts resolve paths relative to package root
- Proxy scripts (`bin/eslint`, etc.) use `require.resolve()` which works in both modes

**Dependencies**:
- In metapackage: May use dependencies from root `node_modules`
- Standalone: Must have all dependencies in local `node_modules`
- Both modes should work identically from user perspective

**Testing**:
- Test setup works in both modes
- When testing, ensure dependencies are properly resolved
- Consider testing both modes if making significant changes

## Setup Commands

**In Metapackage**:
```bash
# From devops/lint directory
npm install  # Uses workspace dependencies

# Or from metapackage root
npm install  # Installs all workspace dependencies
```

**Standalone**:
```bash
# Install dependencies
npm install

# Run tests
npm test
```

## Development Commands

**In Metapackage**:
```bash
# From devops/lint directory
cd test && npm start

# Or using nx from metapackage root
npx nx test @diplodoc/lint  # If configured
```

**Standalone**:
```bash
# Test the package
cd test && npm start
```

## Architecture

### Bin Directory Structure

The `bin/` directory contains executable scripts that are made available via npm bin:

**Main Script: `lint`**
- **Purpose**: Main entry point for all linting operations
- **Commands**:
  - `lint` (default) — runs all linters in check mode
  - `lint fix` — runs all linters in fix mode (auto-fixes issues)
  - `lint init` — initializes linting infrastructure in a package
  - `lint update` — updates linting infrastructure (runs automatically on each `lint` call)

**Proxy Scripts** (redirect to original binaries from node_modules):
- `eslint` — proxies to `eslint/bin/eslint.js`
- `prettier` — proxies to `prettier/bin/prettier.cjs`
- `stylelint` — proxies to `stylelint/bin/stylelint.mjs`
- `husky` — proxies to `husky/bin.js`
- `lint-staged` — proxies to `lint-staged/bin/lint-staged.js`
- `svgo` — proxies to `svgo/bin/svgo`

**How Proxy Scripts Work**:
1. Find the source directory of `@diplodoc/lint` package
2. Use `require.resolve()` to locate the original package in node_modules
3. Redirect execution to the original binary
4. This allows using tools via `npx @diplodoc/lint eslint` instead of `npx eslint`

**Lint Script Behavior**:

**Default mode** (`lint`):
- Runs ESLint on all JS/TS files (check only)
- Runs Prettier in check mode on all JS/TS files
- Runs Stylelint on CSS/SCSS files (if found and not ignored)

**Fix mode** (`lint fix`):
- Runs ESLint with `--fix` flag (auto-fixes issues)
- Runs Prettier with `--write` flag (formats files)
- Runs Stylelint with `--fix` flag (auto-fixes CSS issues)

**Init/Update mode** (`lint init` or `lint update`):
1. **Modify package.json**: Adds/updates lint scripts via `scripts/modify-package.js`
2. **Initialize Husky**: Runs `husky init` (only on `init`)
3. **Copy scaffolding**: Copies all files from `scaffolding/` directory to package root
4. **Update ignore files**: Extends `.gitignore`, `.eslintignore`, `.prettierignore`, `.stylelintignore` via `scripts/modify-ignore.js`

### Infrastructure Auto-Update

**Key Design Principle**: The package automatically checks and updates infrastructure in consuming packages on each run.

**How it works**:
1. `@diplodoc/lint` is installed as a dev dependency in packages
2. It's configured in `prepare` scripts: `"prepare": "husky || true"`
3. On each `lint` command execution, it runs `lint update` first
4. The `update` command checks if scaffolding files are up-to-date
5. If outdated, it automatically copies/updates configuration files
6. This prevents infrastructure drift across packages

**Current Implementation**:
- `lint update` always copies scaffolding files (overwrites existing)
- `lint update` always updates ignore files (adds missing patterns)
- No diff checking - always performs updates

**Potential Improvements**:
- Add hash-based change detection to skip unnecessary file operations
- Cache scaffolding file hashes to avoid redundant copies
- Only update ignore files if patterns are actually missing

### Package Integration

When a package uses `@diplodoc/lint`:

1. **Installation**: `npm install --save-dev @diplodoc/lint`
2. **Initialization**: `npx @diplodoc/lint init`
   - **Step 1**: Modifies `package.json` via `scripts/modify-package.js`
     - Adds `lint`, `lint:fix`, `pre-commit`, `prepare` scripts
   - **Step 2**: Initializes Husky (`husky init`)
     - Creates `.husky/` directory
     - Sets up git hooks
   - **Step 3**: Copies scaffolding files from `scaffolding/` to package root
     - `.eslintrc.js`, `.prettierrc.js`, `.stylelintrc.js`
     - `.lintstagedrc.js`, `.husky/pre-commit`
   - **Step 4**: Updates ignore files via `scripts/modify-ignore.js`
     - Extends `.gitignore`, `.eslintignore`, `.prettierignore`, `.stylelintignore`
     - Adds standard patterns (system files, build artifacts, node_modules)
3. **Usage**: `npm run lint` or `npm run lint:fix`
   - **Automatic update**: Runs `lint update` first (ensures infrastructure is current)
   - **Then**: Runs actual linting (check or fix mode)

**Update Process** (`lint update`):
- Runs automatically on every `lint` command
- Copies scaffolding files (overwrites if changed)
- Updates ignore files (adds missing patterns)
- Does NOT re-initialize Husky (only `init` does that)
- Does NOT modify package.json scripts (only `init` does that)

### Exports

The package exports configurations that can be imported by packages:

- `@diplodoc/lint/eslint-config` — Common ESLint config
- `@diplodoc/lint/eslint-config/client` — Client-side ESLint config
- `@diplodoc/lint/eslint-config/node` — Node.js ESLint config
- `@diplodoc/lint/prettier-config` — Prettier config
- `@diplodoc/lint/stylelint-config` — Stylelint config

Packages can extend these configs at the `src` level if needed.

## Configuration

### Linting Tools

**ESLint**:
- Uses `@gravity-ui/eslint-config` as base
- TypeScript support via `@typescript-eslint/eslint-plugin`
- Import resolution via `eslint-import-resolver-typescript`
- Security checks via `eslint-plugin-security`
- Prettier integration via `eslint-config-prettier`

**Prettier**:
- Uses `@gravity-ui/prettier-config` as base
- Consistent formatting across all packages

**Stylelint**:
- Uses `@gravity-ui/stylelint-config` as base
- CSS and SCSS support

**Husky**:
- Git hooks management
- Pre-commit hook runs `lint-staged`

**lint-staged**:
- Runs linting only on staged files
- Faster pre-commit checks

### Scaffolding Files

Files in `scaffolding/` are copied to packages during `init`/`update`:

**`.eslintrc.js`**:
- Extends `@diplodoc/lint/eslint-config`
- Configures TypeScript parser with project-aware settings
- Sets `root: true` to prevent config inheritance from parent directories

**`.prettierrc.js`**:
- Exports `@diplodoc/lint/prettier-config` directly

**`.stylelintrc.js`**:
- Extends `@diplodoc/lint/stylelint-config`

**`.lintstagedrc.js`**:
- Configures lint-staged to run on staged files:
  - JS/TS files: Prettier + ESLint (with auto-fix)
  - CSS/SCSS files: Prettier + Stylelint (with auto-fix)
  - JSON/YAML/MD files: Prettier
  - SVG files: SVGO optimization

**`.husky/pre-commit`**:
- Runs `npm run pre-commit` before each commit
- Pre-commit script runs `lint update && lint-staged`

**Ignore Files** (updated via `modify-ignore.js`):
- `.gitignore`, `.eslintignore`, `.prettierignore`, `.stylelintignore`
- Adds standard patterns:
  - System files: `.idea`, `.vscode`, `.history`, `.env`, `.DS_Store`
  - Build artifacts: `/lib`, `/dist`, `/build`, `/cache`, `/coverage`, `/external`
  - Dependencies: `node_modules`

## Testing

The package has a test setup in the `test/` directory:
- Test script: `test/test.sh`
- Test package.json configuration
- Validates that linting works correctly

## Code Conventions

1. **File naming**:
   - Config files: `*-config.js` (e.g., `eslint-common-config.js`)
   - Scripts: `modify-*.js` in `scripts/` directory
   - Binaries: executable scripts in `bin/` directory

2. **Comments and documentation**:
   - **All code comments must be in English**
   - **All documentation files (ADR, AGENTS.md, README, etc.) must be in English**

3. **Code style**:
   - Follow standard JavaScript/Node.js conventions
   - Use consistent formatting (enforced by Prettier)

## Common Tasks

### Adding a New Linting Rule

1. Update the appropriate config file (e.g., `eslint-common-config.js`)
2. Test the change in the `test/` directory
3. Update version in `package.json`
4. Packages will pick up the change on next `lint update`

### Modifying Scaffolding Files

1. Update files in `scaffolding/` directory
2. Test with `npx @diplodoc/lint init` in a test package
3. Verify that files are copied correctly
4. Update version in `package.json`

### Adding a New Configuration Export

1. Create the config file (e.g., `new-config.js`)
2. Add export to `package.json`:
   ```json
   {
     "exports": {
       "./new-config": "./new-config.js"
     }
   }
   ```
3. Document the export in README.md
4. Update version in `package.json`

### Updating Dependencies

1. Update dependency versions in `package.json`
2. Test that linting still works with new versions
3. Run `npm test` to verify
4. Update version in `package.json`

## Potential Improvements

### 1. Better Error Messages and Validation

**Current Issues**:
- `modify-package.js` throws plain strings instead of Error objects
- No validation of package.json structure before modification
- No helpful error messages for common issues
- Scripts fail silently in some edge cases

**Improvement Plan**:

**A. Error Handling in `modify-package.js`**:
- Replace string throws with proper Error objects
- Add error context (which script, what operation failed)
- Validate package.json exists and is valid JSON before parsing
- Check if package.json has `scripts` field, create if missing
- Provide helpful messages for common issues:
  - "package.json not found" → suggest running from package root
  - "Invalid JSON" → show line number if possible
  - "Script already exists with different implementation" → show both versions

**B. Error Handling in `modify-ignore.js`**:
- Validate file permissions before writing
- Handle read-only files gracefully
- Provide suggestions if files can't be modified
- Log which patterns were added vs. already existed

**C. Error Handling in `bin/lint`**:
- Better error messages when tools are not found
- Validate scaffolding directory exists before copying
- Check if Husky initialization succeeded
- Provide rollback instructions if init partially fails

**D. Validation**:
- Validate that required dependencies are installed
- Check Node.js version compatibility
- Verify scaffolding files are complete
- Validate exported configs are syntactically correct

**Implementation Steps**:
1. Create error utility module for consistent error formatting
2. Add validation functions for common checks
3. Refactor `modify-package.js` to use proper errors
4. Refactor `modify-ignore.js` to use proper errors
5. Add validation checks to `bin/lint`
6. Test error scenarios and improve messages iteratively

### 2. Better Testing

**Current State**:
- Basic test in `test/` directory that runs init and lint:fix
- No unit tests for individual scripts
- No integration tests for update flow
- No tests for error scenarios

**Improvement Plan**:

**A. Unit Tests**:

**Test `modify-package.js`**:
- Test adding scripts to empty package.json
- Test updating existing scripts (same vs. different)
- Test force mode for `prepare` script
- Test error handling (invalid JSON, missing file)
- Test script preservation (doesn't overwrite unrelated scripts)

**Test `modify-ignore.js`**:
- Test adding patterns to empty ignore files
- Test adding patterns to existing ignore files
- Test duplicate pattern detection
- Test different ignore file types (.gitignore, .eslintignore, etc.)
- Test error handling (read-only files, missing files)

**Test Proxy Scripts** (bin/eslint, bin/prettier, etc.):
- Test require.resolve() finds correct packages
- Test error handling when packages not found
- Test binary execution redirection

**B. Integration Tests**:

**Test `lint init` flow**:
- Test full initialization in clean directory
- Test initialization when some files already exist
- Test Husky initialization
- Test scaffolding file copying
- Test ignore file updates
- Test package.json modification
- Verify all expected files are created

**Test `lint update` flow**:
- Test update when files are up-to-date
- Test update when files are outdated
- Test update when files were manually modified
- Test that Husky is not re-initialized
- Test that package.json scripts are not re-added

**Test `lint` and `lint fix` flows**:
- Test linting with no errors
- Test linting with errors
- Test fix mode actually fixes issues
- Test CSS/SCSS detection logic
- Test ignore file patterns work correctly

**C. Test Infrastructure**:

**Setup**:
- Use Vitest (recommended testing framework)
- Create test fixtures (sample package.json, ignore files)
- Create temporary directories for integration tests
- Mock file system operations where appropriate

**Test Structure**:
```
test/
├── unit/
│   ├── modify-package.test.js
│   ├── modify-ignore.test.js
│   └── bin/
│       ├── eslint.test.js
│       └── prettier.test.js
├── integration/
│   ├── init.test.js
│   ├── update.test.js
│   └── lint.test.js
├── fixtures/
│   ├── package.json
│   ├── .gitignore
│   └── ...
└── helpers/
    ├── setup.js
    └── teardown.js
```

**D. Test Scenarios to Cover**:

**Happy Paths**:
- Clean init in empty directory
- Update in already initialized package
- Linting with no errors
- Fixing linting errors

**Edge Cases**:
- Init when package.json has no scripts field
- Update when scaffolding files were manually modified
- Linting when no JS/TS files exist
- Linting when no CSS files exist
- Ignore files with unusual formats

**Error Cases**:
- Invalid package.json
- Missing dependencies
- Permission errors
- Corrupted scaffolding files
- Network issues (for dependency resolution)

**Implementation Steps**:
1. Set up Vitest configuration
2. Create test fixtures and helpers
3. Write unit tests for `modify-package.js`
4. Write unit tests for `modify-ignore.js`
5. Write integration tests for `init` flow
6. Write integration tests for `update` flow
7. Write integration tests for `lint` flows
8. Add tests to CI/CD pipeline
9. Aim for high code coverage (>80%)

## Important Notes

1. **Auto-update mechanism**: The `lint update` command runs automatically on each `lint` execution. This ensures infrastructure stays in sync across packages.

2. **Backward compatibility**: When updating configs, consider backward compatibility. Breaking changes may require major version bumps.

3. **Package independence**: This package should not depend on other Diplodoc packages (except devops infrastructure like `@diplodoc/tsconfig` if needed).

4. **Scaffolding updates**: When scaffolding files change, packages will automatically get updates on next `lint update` run.

5. **Extensibility**: Packages can extend ESLint configs at the `src` level, but should not override base configs.

6. **Replaces deprecated packages**: This package replaces `@diplodoc/eslint-config` and `@diplodoc/prettier-config`. Do not use those packages.

7. **Used by all packages**: This is a critical infrastructure package used by all Diplodoc packages. Changes should be carefully tested.

8. **Performance consideration**: Running `lint update` on every `lint` call can be slow. Consider implementing smart update detection (see Potential Improvements).

9. **Dual usage mode**: This package works both as part of the metapackage (workspace mode) and as a standalone npm package. All scripts and commands must work correctly in both contexts. When making changes, test both modes to ensure compatibility.

## Additional Resources

- `README.md` — main documentation
- `CONTRIBUTING.md` — contributor guide
- `CHANGELOG.md` — change history
- Metapackage `.agents/` — platform-wide agent documentation
