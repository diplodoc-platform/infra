const {join} = require('node:path');
const {readFileSync, writeFileSync, existsSync} = require('node:fs');
const {dirname} = require('node:path');

const packageJsonPath = join(process.cwd(), 'package.json');
const configTemplatePath = join(dirname(dirname(__filename)), 'scaffolding', '.release-please-config.json.template');
const manifestTemplatePath = join(dirname(dirname(__filename)), 'scaffolding', '.release-please-manifest.json.template');

let pkg;
try {
    pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
} catch {
    throw 'Unable to read ' + packageJsonPath;
}

const packageName = pkg.name || '';
const packageVersion = pkg.version || '1.0.0';

// Read templates
let configTemplate;
let manifestTemplate;
try {
    configTemplate = readFileSync(configTemplatePath, 'utf8');
    manifestTemplate = readFileSync(manifestTemplatePath, 'utf8');
} catch (err) {
    throw 'Unable to read release-please templates: ' + err.message;
}

// Replace placeholders
const configContent = configTemplate
    .replace(/\{\{PACKAGE_NAME\}\}/g, packageName);

const manifestContent = manifestTemplate
    .replace(/\{\{PACKAGE_VERSION\}\}/g, packageVersion)
    .trimEnd(); // Remove trailing whitespace/newlines

// Write files
const configOutputPath = join(process.cwd(), '.release-please-config.json');
const manifestOutputPath = join(process.cwd(), '.release-please-manifest.json');

// Only create if they don't exist (preserve existing configs)
if (!existsSync(configOutputPath)) {
    writeFileSync(configOutputPath, configContent, 'utf8');
    console.log('[@diplodoc/lint]', '=> Create .release-please-config.json');
} else {
    console.log('[@diplodoc/lint]', '=> .release-please-config.json already exists, skipping');
}

if (!existsSync(manifestOutputPath)) {
    writeFileSync(manifestOutputPath, manifestContent, 'utf8');
    console.log('[@diplodoc/lint]', '=> Create .release-please-manifest.json');
} else {
    // Always update manifest with current version
    writeFileSync(manifestOutputPath, manifestContent, 'utf8');
    console.log('[@diplodoc/lint]', '=> Update .release-please-manifest.json');
}


