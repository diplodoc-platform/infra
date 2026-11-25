'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const {isDeepStrictEqual} = require('node:util');
const {OWNER, SHA, github, pages, read, validatePlan} = require('./common');

/** Read data as Git blobs, never following a symlink or executing the candidate. */
async function candidateFile(sha, name, request) {
    const prefix = `/repos/${OWNER}/cli`;
    const root = await request(`${prefix}/git/trees/${sha}`);
    assert.equal(root.truncated, false);
    const directory = root.tree.find((entry) => entry.path === 'dependency-train');
    assert.ok(
        directory?.type === 'tree' && directory.mode === '040000',
        'Missing candidate data directory',
    );
    const tree = await request(`${prefix}/git/trees/${directory.sha}`);
    assert.equal(tree.truncated, false);
    const entry = tree.tree.find((item) => item.path === name);
    assert.ok(
        entry?.type === 'blob' && entry.mode === '100644',
        'Candidate metadata must be a regular blob',
    );
    const blob = await request(`${prefix}/git/blobs/${entry.sha}`);
    assert.ok(blob.encoding === 'base64' && blob.size > 0 && blob.size < 8 * 1024 * 1024);
    return Buffer.from(blob.content.replace(/\s/g, ''), 'base64').toString('utf8');
}

function sourceIdentities(plan) {
    return plan.selected
        .map(({repo, number, sha, baseSha}) => ({repo, number, sha, baseSha}))
        .sort((a, b) => a.repo.localeCompare(b.repo));
}

/** Only replace a bot-owned immutable candidate for the exact selected group. */
async function staleCandidate(pr, plan, request) {
    if (
        pr.state !== 'open' ||
        pr.user?.login !== 'diplodoc-bot' ||
        pr.head.repo?.full_name !== `${OWNER}/cli` ||
        pr.base?.repo?.full_name !== `${OWNER}/cli` ||
        pr.base.ref !== 'master' ||
        !SHA.test(pr.head.sha)
    )
        return null;

    const old = validatePlan(JSON.parse(await candidateFile(pr.head.sha, 'plan.json', request)));
    const commit = await request(`/repos/${OWNER}/cli/git/commits/${pr.head.sha}`);
    assert.equal(pr.head.ref, `codex/dependency-candidate-${old.id}`);
    assert.equal(commit.sha, pr.head.sha);
    assert.deepEqual(
        commit.parents.map(({sha}) => sha),
        [old.cli.sha],
    );

    if (
        old.cli.sha === plan.cli.sha ||
        old.schema !== plan.schema ||
        !isDeepStrictEqual(old.cohort?.dependency, plan.cohort?.dependency) ||
        !isDeepStrictEqual(sourceIdentities(old), sourceIdentities(plan))
    )
        return null;

    return {number: pr.number, sha: pr.head.sha, trainId: old.id};
}

/** Read open candidates before building and again in the publisher. */
async function preparationStatus(plan, request = github, currentNumber) {
    const pulls = await pages(`/repos/${OWNER}/cli/pulls?state=open&base=master`, request);
    const active = pulls.filter((pr) => {
        assert.equal(typeof pr.head?.ref, 'string', 'Missing open PR branch evidence');

        return (
            pr.head.ref.startsWith('codex/dependency-candidate-') &&
            (currentNumber === undefined || pr.number !== currentNumber)
        );
    });
    const candidates = active.map(({number}) => {
        assert.ok(Number.isSafeInteger(number) && number > 0, 'Invalid open candidate');

        return {number, url: `https://github.com/${OWNER}/cli/pull/${number}`};
    });
    const replacement = active.length === 1 ? await staleCandidate(active[0], plan, request) : null;

    return {available: active.length === 0 || replacement !== null, candidates, replacement};
}

/** Report a blocker without treating an existing candidate as verified. */
function renderPreparationStatus(status) {
    if (status.replacement) {
        const [{number, url}] = status.candidates;
        return `\n[CLI #${number}](${url}) has a stale baseline. It will be closed only after the replacement is published.\n`;
    }
    if (status.available) return '\nNo open CLI candidate blocks preparation.\n';

    return (
        '\n### Preparation blocked before build\n\n' +
        status.candidates.map((pr) => `- [CLI #${pr.number}](${pr.url})`).join('\n') +
        '\n\nResolve the existing candidate before preparing another wave. ' +
        'Its presence is **not successful verification**; nothing was merged or closed.\n'
    );
}

if (require.main === module) {
    Promise.resolve()
        .then(() => preparationStatus(validatePlan(read('train-plan.json'))))
        .then((status) => {
            fs.appendFileSync(
                process.env.GITHUB_OUTPUT,
                `available=${status.available}\nreplacing=${Boolean(status.replacement)}\n`,
            );
            fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, renderPreparationStatus(status));
        })
        .catch((error) => {
            console.error(error.message);
            process.exitCode = 1;
        });
}

module.exports = {candidateFile, preparationStatus, renderPreparationStatus};
