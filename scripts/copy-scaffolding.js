const {join, relative, dirname} = require('node:path');
const {
    readdirSync,
    readFileSync,
    writeFileSync,
    copyFileSync,
    mkdirSync,
    existsSync,
    realpathSync,
} = require('node:fs');

// Determine package root directory
// Try multiple strategies to find the package root
let srcDir = join(__dirname, '../scaffolding');

// If scaffolding doesn't exist at expected location, try to find package via require.resolve
if (!existsSync(srcDir)) {
    try {
        // Try to find the package root via require.resolve
        const packageJsonPath = require.resolve('@diplodoc/infra/package.json');
        const packageRoot = dirname(packageJsonPath);
        srcDir = join(packageRoot, 'scaffolding');
    } catch (e) {
        // If require.resolve fails, try walking up from __dirname
        let currentDir = __dirname;
        for (let i = 0; i < 5; i++) {
            const testScaffolding = join(currentDir, 'scaffolding');
            if (existsSync(testScaffolding)) {
                srcDir = testScaffolding;
                break;
            }
            const parentDir = dirname(currentDir);
            if (parentDir === currentDir) {
                break;
            }
            currentDir = parentDir;
        }
    }
}

const targetDir = process.env.INFRA_TARGET_DIR || process.cwd();

let infraBlacklist = [];
if (process.env.INFRA_BLACKLIST) {
    try {
        infraBlacklist = JSON.parse(process.env.INFRA_BLACKLIST);
    } catch {
        // ignore invalid blacklist
    }
}

/** @type {{ PACKAGE_NAME: string }} Variables for scaffolding template substitution */
let scaffoldVars = {PACKAGE_NAME: 'package'};
const packageJsonPath = join(targetDir, 'package.json');
if (existsSync(packageJsonPath)) {
    try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
        const name = pkg.name && typeof pkg.name === 'string' ? pkg.name : '';
        scaffoldVars.PACKAGE_NAME = name.replace(/^@[^/]+\//, '') || 'package';
    } catch {
        // leave default
    }
}

function applyTemplate(content) {
    if (typeof content !== 'string' || !content.includes('{{')) {
        return content;
    }
    return content.replace(/\{\{PACKAGE_NAME\}\}/g, scaffoldVars.PACKAGE_NAME);
}

function copyFileWithSubstitution(srcPath, targetPath) {
    let content;
    try {
        content = readFileSync(srcPath, 'utf8');
    } catch {
        copyFileSync(srcPath, targetPath);
        return;
    }
    if (content.includes('{{PACKAGE_NAME}}')) {
        writeFileSync(targetPath, applyTemplate(content), 'utf8');
    } else {
        writeFileSync(targetPath, content, 'utf8');
    }
}

// Verify scaffolding directory exists
if (!existsSync(srcDir)) {
    console.error(`[@diplodoc/infra] Error: scaffolding directory not found at ${srcDir}`);
    process.exit(1);
}

function matchesGlob(filePath, pattern) {
    if (pattern.includes('*')) {
        const regexStr = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
        return new RegExp(`^${regexStr}$`).test(filePath);
    }
    return false;
}

function copyScaffoldingFiles(excludePatterns = []) {
    function shouldExclude(filePath) {
        const relPath = relative(srcDir, filePath);

        if (infraBlacklist.length > 0) {
            for (const pattern of infraBlacklist) {
                if (relPath === pattern || relPath.startsWith(pattern)) return true;
                if (matchesGlob(relPath, pattern)) return true;
            }
        }

        return excludePatterns.some((pattern) => {
            if (typeof pattern === 'string') {
                return relPath.includes(pattern) || relPath.startsWith(pattern);
            }
            if (pattern instanceof RegExp) {
                return pattern.test(relPath);
            }
            return false;
        });
    }

    function copyRecursive(src, target) {
        const entries = readdirSync(src, {withFileTypes: true});

        for (const entry of entries) {
            const srcPath = join(src, entry.name);
            const targetPath = join(target, entry.name);

            if (shouldExclude(srcPath)) {
                continue;
            }

            if (entry.isDirectory()) {
                if (!existsSync(targetPath)) {
                    mkdirSync(targetPath, {recursive: true});
                }
                copyRecursive(srcPath, targetPath);
            } else if (entry.isFile()) {
                // Ensure target directory exists
                const targetParent = dirname(targetPath);
                if (!existsSync(targetParent)) {
                    mkdirSync(targetParent, {recursive: true});
                }
                // Force overwrite existing files (with optional {{PACKAGE_NAME}} substitution)
                try {
                    copyFileWithSubstitution(srcPath, targetPath);
                } catch (error) {
                    console.error(
                        `[@diplodoc/infra] Error copying ${srcPath} to ${targetPath}:`,
                        error.message,
                    );
                    throw error;
                }
            }
        }
    }

    copyRecursive(srcDir, targetDir);
}

function copyWorkflows() {
    const workflowsSrc = join(srcDir, '.github/workflows');
    const workflowsTarget = join(targetDir, '.github/workflows');

    if (!existsSync(workflowsSrc)) {
        return;
    }

    if (!existsSync(workflowsTarget)) {
        mkdirSync(workflowsTarget, {recursive: true});
    }

    const entries = readdirSync(workflowsSrc, {withFileTypes: true});
    for (const entry of entries) {
        if (entry.isFile()) {
            const relPath = `.github/workflows/${entry.name}`;
            const isBlacklisted = infraBlacklist.some(
                (pattern) =>
                    relPath === pattern ||
                    relPath.startsWith(pattern) ||
                    matchesGlob(relPath, pattern),
            );
            if (isBlacklisted) {
                console.log(`[@diplodoc/infra] Skipping ${relPath} (blacklisted)`);
                continue;
            }
            const srcPath = join(workflowsSrc, entry.name);
            const targetPath = join(workflowsTarget, entry.name);
            copyFileWithSubstitution(srcPath, targetPath);
        }
    }
}

// Copy scaffolding files (exclude templates and workflows)
copyScaffoldingFiles(['.template', '.github/workflows']);

// Copy workflows separately (always overwrite)
copyWorkflows();
