const {join, relative, dirname} = require('node:path');
const {readdirSync, copyFileSync, mkdirSync, existsSync} = require('node:fs');

// Use __dirname to find scaffolding relative to this script
// Script is in scripts/, scaffolding is in package root
const srcDir = join(__dirname, '../scaffolding');
const targetDir = process.cwd();

// Verify scaffolding directory exists
if (!existsSync(srcDir)) {
    console.error(`[@diplodoc/lint] Error: scaffolding directory not found at ${srcDir}`);
    console.error(`[@diplodoc/lint] Script location: ${__dirname}`);
    console.error(`[@diplodoc/lint] Target directory: ${targetDir}`);
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
                    // Log important files being copied for debugging
                    if (entry.name === '.eslintrc.js' || entry.name === '.prettierrc.js' || entry.name === '.stylelintrc.js') {
                        console.log(`[@diplodoc/lint] Copied ${entry.name} from ${srcPath} to ${targetPath}`);
                    }
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
console.log(`[@diplodoc/lint] Copying scaffolding files from ${srcDir} to ${targetDir}`);
copyScaffoldingFiles([
    '.template',
    '.github/workflows',
]);

// Copy workflows separately (always overwrite)
copyWorkflows();
console.log(`[@diplodoc/lint] Finished copying scaffolding files`);

