'use strict';

const {createHash} = require('node:crypto');
const fs = require('node:fs');
const {join} = require('node:path');
const yaml = require('js-yaml');
const {isExcluded} = require('./scaffolding-blacklist');

const LEGACY_WORKFLOW = '.github/workflows/dependency-deep-verification.yml';
const ASSESSMENT_WORKFLOW = '.github/workflows/dependency-risk-assessment.yml';
// Exact distributed 2.3.0 template; never delete an unrecognized consumer workflow.
const LEGACY_SHA256 = '69b02029540f05bb37a80420b028e86f586668d7ed883cce498bc64c39117086';

/** Preserve legacy central/local exclusions as opt-outs from the optional deep job. */
function configureDeepVerification(content, relativePath, blacklist) {
    if (relativePath !== ASSESSMENT_WORKFLOW || !isExcluded(LEGACY_WORKFLOW, blacklist)) {
        return content;
    }

    const workflow = yaml.load(content);
    delete workflow.jobs['deep-verification'];
    return yaml.dump(workflow, {lineWidth: 100, noRefs: true});
}

/** Remove the recognized predecessor only after its replacement has been copied. */
function removeLegacyDeepWorkflow(target, blacklist) {
    if (isExcluded(LEGACY_WORKFLOW, blacklist) || isExcluded(ASSESSMENT_WORKFLOW, blacklist)) {
        return;
    }

    const legacy = join(target, LEGACY_WORKFLOW);
    if (!fs.existsSync(legacy) || !fs.existsSync(join(target, ASSESSMENT_WORKFLOW))) return;

    const stat = fs.lstatSync(legacy);
    const digest = stat.isFile()
        ? createHash('sha256')
              .update(fs.readFileSync(legacy, 'utf8').replace(/\r\n/g, '\n'))
              .digest('hex')
        : null;
    if (digest !== LEGACY_SHA256) {
        console.warn(
            `[@diplodoc/infra] Preserving custom ${LEGACY_WORKFLOW}; migrate it manually to avoid duplicate checks`,
        );
        return;
    }

    fs.unlinkSync(legacy);
    console.log(
        `[@diplodoc/infra] Removed ${LEGACY_WORKFLOW}; deep verification is in Dependency Risk Assessment`,
    );
}

module.exports = {
    LEGACY_WORKFLOW,
    ASSESSMENT_WORKFLOW,
    configureDeepVerification,
    removeLegacyDeepWorkflow,
};
