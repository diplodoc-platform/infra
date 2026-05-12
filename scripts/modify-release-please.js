const {join} = require('node:path');
const {readFileSync, writeFileSync, existsSync} = require('node:fs');
const {dirname} = require('node:path');

const targetDir = process.env.INFRA_TARGET_DIR || process.cwd();
const packageJsonPath = join(targetDir, 'package.json');
const configTemplatePath = join(
    dirname(dirname(__filename)),
    'scaffolding',
    '.release-please-config.json.template',
);
const manifestTemplatePath = join(
    dirname(dirname(__filename)),
    'scaffolding',
    '.release-please-manifest.json.template',
);

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
const configContent = configTemplate.replace(/\{\{PACKAGE_NAME\}\}/g, packageName);

const manifestContent =
    manifestTemplate.replace(/\{\{PACKAGE_VERSION\}\}/g, packageVersion).trimEnd() + '\n'; // Remove trailing whitespace/newlines

// Write files
const configOutputPath = join(targetDir, '.release-please-config.json');
const manifestOutputPath = join(targetDir, '.release-please-manifest.json');

if (!existsSync(configOutputPath)) {
    console.log('[@diplodoc/infra]', '=> Create .release-please-config.json');
    writeFileSync(configOutputPath, configContent, 'utf8');
}

console.log('[@diplodoc/infra]', '=> Update .release-please-manifest.json');
writeFileSync(manifestOutputPath, manifestContent, 'utf8');
