'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const {OWNER, github, pages} = require('./common');

/** Read open candidates before starting an expensive preparation job. */
async function preparationStatus(request = github) {
    const pulls = await pages(`/repos/${OWNER}/cli/pulls?state=open&base=master`, request);
    const candidates = pulls
        .filter((pr) => {
            assert.equal(typeof pr.head?.ref, 'string', 'Missing open PR branch evidence');

            return pr.head.ref.startsWith('codex/dependency-candidate-');
        })
        .map((pr) => {
            assert.ok(Number.isSafeInteger(pr.number) && pr.number > 0, 'Invalid open candidate');

            return {number: pr.number, url: `https://github.com/${OWNER}/cli/pull/${pr.number}`};
        });

    return {available: candidates.length === 0, candidates};
}

/** Report a blocker without treating an existing candidate as verified. */
function renderPreparationStatus(status) {
    if (status.available) return '\nNo open CLI candidate blocks preparation.\n';

    return (
        '\n### Preparation blocked before build\n\n' +
        status.candidates.map((pr) => `- [CLI #${pr.number}](${pr.url})`).join('\n') +
        '\n\nResolve the existing candidate before preparing another wave. ' +
        'Its presence is **not successful verification**; nothing was merged or closed.\n'
    );
}

if (require.main === module) {
    preparationStatus()
        .then((status) => {
            fs.appendFileSync(process.env.GITHUB_OUTPUT, `available=${status.available}\n`);
            fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, renderPreparationStatus(status));
        })
        .catch((error) => {
            console.error(error.message);
            process.exitCode = 1;
        });
}

module.exports = {preparationStatus, renderPreparationStatus};
