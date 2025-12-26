const {join, relative, dirname} = require('node:path');
const {readdirSync, copyFileSync, mkdirSync, existsSync, realpathSync} = require('node:fs');

// Determine package root directory
// Try multiple strategies to find the package root
let srcDir = join(__dirname, '../scaffolding');

// If scaffolding doesn't exist at expected location, try to find package via require.resolve
if (!existsSync(srcDir)) {
    try {
        // Try to find the package root via require.resolve
        const packageJsonPath = require.resolve('@diplodoc/lint/package.json');
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

const targetDir = process.cwd();

// Verify scaffolding directory exists
if (!existsSync(srcDir)) {
    console.error(`[@diplodoc/lint] Error: scaffolding directory not found at ${srcDir}`);
    process.exit(1);
}

function copyScaffoldingFiles(excludePatterns = []) {
    function shouldExclude(filePath) {
        const relPath = relative(srcDir, filePath);
        return excludePatterns.some(pattern => {
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
                // Force overwrite existing files
                try {
                    copyFileSync(srcPath, targetPath);
                } catch (error) {
                    console.error(`[@diplodoc/lint] Error copying ${srcPath} to ${targetPath}:`, error.message);
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
            const srcPath = join(workflowsSrc, entry.name);
            const targetPath = join(workflowsTarget, entry.name);
            copyFileSync(srcPath, targetPath);
        }
    }
}

// Copy scaffolding files (exclude templates and workflows)
copyScaffoldingFiles([
    '.template',
    '.github/workflows',
]);

// Copy workflows separately (always overwrite)
copyWorkflows();

