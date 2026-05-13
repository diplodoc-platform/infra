#!/usr/bin/env node

const {execSync} = require('node:child_process');
const {realpathSync, readFileSync, existsSync, writeFileSync, mkdirSync} = require('node:fs');
const {dirname, join, resolve} = require('node:path');
const yaml = require('js-yaml');

const scriptPath = realpathSync(__filename);
const srcDir = dirname(dirname(scriptPath));
const binDir = join(srcDir, 'bin');

const args = process.argv.slice(2);
const command = args[0];

const isWindows = process.platform === 'win32';
const shell = isWindows ? 'sh' : 'bash';

const flags = {};
for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--')) {
        const key = args[i].slice(2);
        const next = args[i + 1];
        if (next && !next.startsWith('--')) {
            flags[key] = next;
            i++;
        } else {
            flags[key] = true;
        }
    }
}

function execCommand(cmd, options = {}) {
    try {
        return execSync(cmd, {
            stdio: 'inherit',
            shell,
            cwd: process.cwd(),
            ...options,
        });
    } catch (error) {
        process.exit(error.status || 1);
    }
}



function loadYaml(filePath) {
    const content = readFileSync(filePath, 'utf8');
    return yaml.load(content) || {};
}

function loadInfrarc(targetDir) {
    const infrarcPath = join(targetDir, '.infrarc.yml');
    if (!existsSync(infrarcPath)) return [];

    const config = loadYaml(infrarcPath);
    return config.exclude || [];
}

function loadBlacklist(repoName, targetDir, configPath) {
    let centralExcludes = [];

    if (configPath && existsSync(configPath)) {
        const config = loadYaml(configPath);
        const repoConfig = config.repos?.[repoName];
        centralExcludes = repoConfig?.exclude || [];
    }

    const localExcludes = loadInfrarc(targetDir);

    const now = new Date();
    return [...centralExcludes, ...localExcludes]
        .map((entry) => (typeof entry === 'string' ? {path: entry} : entry))
        .filter((entry) => !entry.until || new Date(entry.until) > now);
}

function getRepoConfig(repoName, configPath) {
    if (!configPath || !existsSync(configPath)) return {};
    const config = loadYaml(configPath);
    const defaults = config.defaults || {};
    const repoConfig = config.repos?.[repoName] || {};
    return {...defaults, ...repoConfig};
}

function getAllRepos(configPath) {
    if (!configPath || !existsSync(configPath)) return [];
    const config = loadYaml(configPath);
    return Object.keys(config.repos || {});
}

function showHelp() {
    console.log(`
@diplodoc/infra — Infrastructure management CLI

Usage:
  infra init                Initialize infrastructure in current package
  infra update              Update scaffolding in current package
  infra sync                Distribute infrastructure to target repositories
  infra blacklist show      Show blacklist for a repository
  infra blacklist audit     Check for expired exclusions

Sync options:
  --target <path>           Apply scaffolding to a local directory
  --repo <name>             Target a specific repository
  --all                     Target all repositories from distribution.yml
  --dry-run                 Show diff without creating PRs
  --config <path>           Path to distribution.yml (default: ./distribution.yml)
  --output <path>           Output diff report to file (with --dry-run)

Blacklist options:
  --repo <name>             Repository to inspect
  --config <path>           Path to distribution.yml
`);
}

function runInit() {
    console.log('[@diplodoc/infra] Extend package.json configuration');
    execCommand(`node "${join(srcDir, 'scripts/modify-package.js')}"`);
    execCommand(`"${join(binDir, 'husky')}" init`);

    console.log('[@diplodoc/infra] Copy scaffolding files');
    execCommand(`node "${join(srcDir, 'scripts/copy-scaffolding.js')}"`);

    console.log('[@diplodoc/infra] Extend .ignore configuration');
    execCommand(`node "${join(srcDir, 'scripts/modify-ignore.js')}"`);

    console.log('[@diplodoc/infra] Setup release-please configuration');
    execCommand(`node "${join(srcDir, 'scripts/modify-release-please.js')}"`);
}

function runUpdate() {
    console.log('[@diplodoc/infra] Copy scaffolding files');
    execCommand(`node "${join(srcDir, 'scripts/copy-scaffolding.js')}"`);

    console.log('[@diplodoc/infra] Extend .ignore configuration');
    execCommand(`node "${join(srcDir, 'scripts/modify-ignore.js')}"`);

    console.log('[@diplodoc/infra] Setup release-please configuration');
    execCommand(`node "${join(srcDir, 'scripts/modify-release-please.js')}"`);
}

function runSync() {
    const configPath = resolve(flags.config || join(srcDir, 'distribution.yml'));
    const dryRun = !!flags['dry-run'];
    const outputFile = flags.output;
    const targetPath = flags.target;
    const repoFilter = flags.repo;
    const all = !!flags.all;

    if (targetPath) {
        const absTarget = resolve(targetPath);
        const repoName = repoFilter || 'unknown';
        const blacklist = loadBlacklist(repoName, absTarget, configPath);
        if (dryRun) {
            applySyncToTarget(absTarget, repoName, blacklist, false);
            const report = generateDiffReport(absTarget, repoName, blacklist);
            const formatted = formatDiffReports([report]);
            console.log(formatted);
            if (outputFile) {
                writeFileSync(outputFile, formatted, 'utf8');
            }
            // Revert changes in target directory
            try {
                execSync('git checkout -- . && git clean -fd', {cwd: absTarget, stdio: 'pipe', shell});
            } catch {
                // Not a git repo or no changes to revert
            }
        } else {
            applySyncToTarget(absTarget, repoName, blacklist, false);
        }
        return;
    }

    if (!repoFilter && !all) {
        console.error('Error: specify --repo <name>, --all, or --target <path>');
        process.exit(1);
    }

    const repos = repoFilter ? [repoFilter] : getAllRepos(configPath);
    if (repos.length === 0) {
        console.error('Error: no repositories found in distribution config');
        process.exit(1);
    }

    const reports = [];

    for (const repo of repos) {
        console.log(`\n--- Processing ${repo} ---`);
        const repoConfig = getRepoConfig(repo, configPath);
        const ghRepo = repoConfig.github || `diplodoc-platform/${repo}`;

        const tmpDir = join(process.cwd(), '.infra-sync-tmp', repo);
        if (!existsSync(tmpDir)) {
            mkdirSync(tmpDir, {recursive: true});
        }

        try {
            execSync(`gh repo clone ${ghRepo} "${tmpDir}" -- --depth 1`, {
                stdio: 'pipe',
                shell,
            });
        } catch (error) {
            console.error(`Failed to clone ${ghRepo}: ${error.message}`);
            continue;
        }

        const blacklist = loadBlacklist(repo, tmpDir, configPath);

        if (dryRun) {
            applySyncToTarget(tmpDir, repo, blacklist, false);
            const report = generateDiffReport(tmpDir, repo, blacklist);
            reports.push(report);
            if (report.hasChanges) {
                console.log(`  ${repo}: changes detected`);
            } else {
                console.log(`  ${repo}: no changes`);
            }
        } else {
            applySyncToTarget(tmpDir, repo, blacklist, false);

            const version = flags.version || 'latest';
            const branchName = `infra/update-v${version}`;

            try {
                execSync(
                    [
                        `cd "${tmpDir}"`,
                        `git checkout -b ${branchName}`,
                        'git add -A',
                        `git diff --cached --quiet || git commit -m "chore: update infrastructure to v${version}"`,
                        `git push origin ${branchName}`,
                        `gh pr create --title "chore: update infrastructure to v${version}" --body "Automated infrastructure update from @diplodoc/infra v${version}"`,
                    ].join(' && '),
                    {stdio: 'inherit', shell},
                );

                if (repoConfig.auto_merge !== false) {
                    try {
                        execSync(`cd "${tmpDir}" && gh pr merge --auto --squash`, {
                            stdio: 'pipe',
                            shell,
                        });
                    } catch {
                        console.log(`Note: auto-merge not available for ${repo}`);
                    }
                }
            } catch (error) {
                console.error(`Failed to create PR for ${repo}: ${error.message}`);
            }
        }
    }

    if (dryRun && outputFile) {
        writeFileSync(outputFile, formatDiffReports(reports), 'utf8');
        console.log(`\nDiff report written to ${outputFile}`);
    }

    // Cleanup
    const tmpBase = join(process.cwd(), '.infra-sync-tmp');
    if (existsSync(tmpBase)) {
        try {
            execSync(`rm -rf "${tmpBase}"`, {shell, stdio: 'pipe'});
        } catch {
            // ignore cleanup errors
        }
    }
}

function applySyncToTarget(targetDir, repoName, blacklist, dryRun) {
    if (dryRun) return;

    const blacklistPaths = blacklist.map((e) => e.path);

    const env = {
        ...process.env,
        INFRA_TARGET_DIR: targetDir,
        INFRA_BLACKLIST: JSON.stringify(blacklistPaths),
    };

    execCommand(`node "${join(srcDir, 'scripts/copy-scaffolding.js')}"`, {cwd: targetDir, env});
    execCommand(`node "${join(srcDir, 'scripts/modify-ignore.js')}"`, {cwd: targetDir, env});
    execCommand(`node "${join(srcDir, 'scripts/modify-release-please.js')}"`, {
        cwd: targetDir,
        env,
    });
}

function generateDiffReport(targetDir, repoName, blacklist) {
    const lines = [];
    let hasChanges = false;

    if (blacklist.length > 0) {
        lines.push('**Excluded files (blacklist):**');
        for (const entry of blacklist) {
            const reason = entry.reason ? ` — ${entry.reason}` : '';
            const until = entry.until ? ` (until ${entry.until})` : '';
            lines.push(`- \`${entry.path}\`${reason}${until}`);
        }
        lines.push('');
    }

    try {
        const diff = execSync('git diff --stat', {
            cwd: targetDir,
            encoding: 'utf8',
            stdio: 'pipe',
        });
        if (diff.trim()) {
            hasChanges = true;
            lines.push('**Changes:**');
            lines.push('```');
            lines.push(diff.trim());
            lines.push('```');
        }
    } catch {
        lines.push('Unable to generate diff.');
    }

    return {repoName, hasChanges, body: lines.join('\n')};
}

function formatDiffReports(reports) {
    const noChanges = reports.filter((r) => !r.hasChanges && !r.body.includes('blacklist'));
    const withChanges = reports.filter((r) => r.hasChanges || r.body.includes('blacklist'));

    // Group repos with identical diffs
    const groups = new Map();
    for (const report of withChanges) {
        const key = report.body;
        if (!groups.has(key)) {
            groups.set(key, []);
        }
        groups.get(key).push(report.repoName);
    }

    const lines = [];

    for (const [body, repos] of groups) {
        if (repos.length === 1) {
            lines.push(`## ${repos[0]}\n`);
            lines.push(body);
        } else {
            lines.push(`## ${repos.join(', ')} (${repos.length} repos)\n`);
            lines.push(body);
        }
        lines.push('\n---\n');
    }

    if (noChanges.length > 0) {
        lines.push('<details>');
        lines.push(`<summary>No changes (${noChanges.length} repos)</summary>\n`);
        lines.push(noChanges.map((r) => `- ${r.repoName}`).join('\n'));
        lines.push('\n</details>');
    }

    return lines.join('\n');
}

function runBlacklistShow() {
    const repoName = flags.repo;
    if (!repoName) {
        console.error('Error: --repo is required');
        process.exit(1);
    }

    const configPath = resolve(flags.config || join(srcDir, 'distribution.yml'));
    const blacklist = loadBlacklist(repoName, process.cwd(), configPath);

    if (blacklist.length === 0) {
        console.log(`No exclusions for ${repoName}`);
        return;
    }

    console.log(`Exclusions for ${repoName}:\n`);
    for (const entry of blacklist) {
        const reason = entry.reason ? `\n    Reason: ${entry.reason}` : '';
        const until = entry.until ? `\n    Until: ${entry.until}` : '';
        console.log(`  - ${entry.path}${reason}${until}`);
    }
}

function runBlacklistAudit() {
    const configPath = resolve(flags.config || join(srcDir, 'distribution.yml'));
    if (!existsSync(configPath)) {
        console.log('No distribution.yml found');
        return;
    }

    const config = loadYaml(configPath);
    const now = new Date();
    let hasExpired = false;

    for (const [repoName, repoConfig] of Object.entries(config.repos || {})) {
        const excludes = repoConfig.exclude || [];
        for (const entry of excludes) {
            if (typeof entry === 'object' && entry.until) {
                const expiry = new Date(entry.until);
                if (expiry <= now) {
                    hasExpired = true;
                    console.log(
                        `EXPIRED: ${repoName} — ${entry.path} (expired ${entry.until})${entry.reason ? ` — ${entry.reason}` : ''}`,
                    );
                }
            }
        }
    }

    if (!hasExpired) {
        console.log('No expired exclusions found.');
    }
}

switch (command) {
    case 'init':
        runInit();
        break;
    case 'update':
        runUpdate();
        break;
    case 'sync':
        runSync();
        break;
    case 'blacklist':
        if (args[1] === 'show') {
            runBlacklistShow();
        } else if (args[1] === 'audit') {
            runBlacklistAudit();
        } else {
            console.error('Unknown blacklist command. Use: show, audit');
            process.exit(1);
        }
        break;
    case 'help':
    case '--help':
    case '-h':
        showHelp();
        break;
    default:
        showHelp();
        process.exit(command ? 1 : 0);
}
