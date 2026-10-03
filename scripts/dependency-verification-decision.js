#!/usr/bin/env node

'use strict';

const fs = require('node:fs');

/** Validate classifier evidence before exporting a reusable-workflow decision. */
function verificationDecision(assessment, expectedSha) {
    const deepProfiles = new Set(['document-transform', 'document-rendering', 'ecosystem']);
    const summary = assessment.summary;
    if (
        typeof assessment.hasDependencyChanges !== 'boolean' ||
        !summary ||
        !Number.isSafeInteger(summary.total) ||
        summary.total < 0 ||
        !Array.isArray(assessment.direct) ||
        !Array.isArray(assessment.transitive) ||
        summary.total !== assessment.direct.length + assessment.transitive.length ||
        assessment.hasDependencyChanges !== summary.total > 0 ||
        !['low', 'medium', 'high', 'critical'].includes(assessment.maxRisk) ||
        !['standard-ci', ...deepProfiles].includes(assessment.verificationProfile) ||
        !/^[a-f0-9]{40}$/i.test(expectedSha || '') ||
        assessment.headSha !== expectedSha
    )
        throw new Error('Invalid or inconsistent dependency assessment');
    return {
        outputs:
            [
                `has-dependency-changes=${assessment.hasDependencyChanges}`,
                `profile=${assessment.verificationProfile}`,
                `risk=${assessment.maxRisk}`,
                `run-deep=${assessment.hasDependencyChanges && deepProfiles.has(assessment.verificationProfile)}`,
            ].join('\n') + '\n',
        summary: `Dependency changes: \`${summary.total}\`\n\nRisk: \`${assessment.maxRisk}\`\n\nProfile: \`${assessment.verificationProfile}\`\n\n`,
    };
}

function main(env = process.env) {
    const assessment = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const result = verificationDecision(assessment, env.EXPECTED_SHA);
    fs.appendFileSync(env.GITHUB_OUTPUT, result.outputs);
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, result.summary);
}

if (require.main === module) main();
module.exports = {verificationDecision};
