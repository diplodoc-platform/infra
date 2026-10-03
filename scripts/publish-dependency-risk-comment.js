'use strict';

const fs = require('node:fs');

/** Publish bounded artifact text only for the current PR head and our own marker. */
async function publishDependencyRiskComment(
    {github, context, core},
    env = process.env,
    files = fs,
) {
    const file = 'artifacts/dependency-risk/comment.md';
    const metadataFile = 'artifacts/dependency-risk/metadata.json';
    for (const [name, limit] of [
        [file, 65536],
        [metadataFile, 4096],
    ]) {
        const stat = files.lstatSync(name);
        if (!stat.isFile() || stat.size < 1 || stat.size > limit)
            throw new Error('Invalid assessment artifact');
    }
    const metadata = JSON.parse(files.readFileSync(metadataFile, 'utf8'));
    const expectedPr = env.EXPECTED_PR;
    const expectedSha = env.EXPECTED_SHA;
    if (
        !/^[1-9][0-9]*$/.test(expectedPr || '') ||
        !/^[a-f0-9]{40}$/i.test(expectedSha || '') ||
        String(metadata.pr) !== expectedPr ||
        metadata.headSha !== expectedSha
    )
        throw new Error('Assessment artifact does not match workflow run');
    const request = {...context.repo, pull_number: Number(expectedPr)};
    const current = await github.rest.pulls.get(request);
    if (current.data.state !== 'open' || current.data.head.sha !== expectedSha) {
        core.info('Skipping obsolete dependency assessment');
        return;
    }
    const marker = '<!-- diplodoc:dependency-risk-assessment -->';
    const body =
        marker +
        '\nAssessment for commit `' +
        expectedSha +
        '`\n\n' +
        files.readFileSync(file, 'utf8');
    const comments = await github.paginate(github.rest.issues.listComments, {
        ...context.repo,
        issue_number: Number(expectedPr),
        per_page: 100,
    });
    const own = comments.find(
        (comment) =>
            comment.user?.login === 'github-actions[bot]' && comment.body?.startsWith(marker),
    );
    const latest = await github.rest.pulls.get(request);
    if (latest.data.state !== 'open' || latest.data.head.sha !== expectedSha) return;
    if (own) await github.rest.issues.updateComment({...context.repo, comment_id: own.id, body});
    else
        await github.rest.issues.createComment({
            ...context.repo,
            issue_number: Number(expectedPr),
            body,
        });
}

module.exports = publishDependencyRiskComment;
