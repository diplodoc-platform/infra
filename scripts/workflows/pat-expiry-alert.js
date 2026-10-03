/** Workflow adapter; keeps reporting logic outside YAML. */
module.exports = async function patExpiryAlert(
    {github, context, core},
    env = process.env,
    files = require('node:fs'),
) {
    const fs = files;
    let result;
    try {
        result = JSON.parse(fs.readFileSync('.status/pat-expiry.json', 'utf8'));
    } catch (err) {
        core.setFailed(`Could not read PAT expiry result: ${err.message}`);
        return;
    }

    const {status, login, daysLeft, expiresAt, thresholdDays, reason} = result;

    // Summary line for the run.
    await core.summary
        .addRaw(
            `## INFRA_APPROVER_PAT expiry check\n\n` +
                `- User: \`${login}\`\n` +
                `- Status: **${status}**\n` +
                (daysLeft != null ? `- Days left: **${daysLeft}**\n` : '') +
                (expiresAt ? `- Expires: \`${expiresAt}\`\n` : '') +
                (reason ? `- Detail: ${reason}\n` : ''),
        )
        .write();

    if (status === 'ok') {
        core.notice(`PAT for ${login} is healthy (${daysLeft} day(s) left).`);
        return;
    }

    // For warn / expired / missing / error — open or update a tracking issue.
    const {owner, repo} = context.repo;
    const teamSlug = env.PAT_ROTATION_TEAM || 'team';

    // Resolve team members to auto-assign + @mention. Best-effort: needs
    // org "Members: read"; on failure we still file the issue (with the
    // team @mention, which notifies the team regardless of assignment).
    let assignees = [];
    try {
        const members = await github.paginate(github.rest.teams.listMembersInOrg, {
            org: owner,
            team_slug: teamSlug,
            per_page: 100,
        });
        // GitHub caps assignees at 10.
        assignees = members.map((m) => m.login).slice(0, 10);
    } catch (e) {
        core.warning(`Could not list @${owner}/${teamSlug} members for assignment: ${e.message}`);
    }

    const title = 'INFRA_APPROVER_PAT needs rotation';
    const body =
        `Automated check of the \`diplodoc-bot\` fine-grained PAT (\`INFRA_APPROVER_PAT\`).\n\n` +
        `- Status: **${status}**\n` +
        (daysLeft != null ? `- Days left: **${daysLeft}** (threshold ${thresholdDays})\n` : '') +
        (expiresAt ? `- Expires: \`${expiresAt}\`\n` : '') +
        (reason ? `- Detail: ${reason}\n` : '') +
        `\nGitHub provides no API to regenerate a fine-grained PAT — rotation is manual. ` +
        `Follow the rotation procedure in ADR-001 (Operational Notes).\n\n` +
        `cc @${owner}/${teamSlug}`;

    const existing = await github.rest.issues.listForRepo({
        owner,
        repo,
        state: 'open',
        labels: 'pat-rotation',
        per_page: 100,
    });
    const found = existing.data.find((i) => i.title === title);

    if (found) {
        await github.rest.issues.createComment({
            owner,
            repo,
            issue_number: found.number,
            body,
        });
        // Make sure assignees are set even if the issue was opened earlier.
        if (assignees.length > 0) {
            try {
                await github.rest.issues.addAssignees({
                    owner,
                    repo,
                    issue_number: found.number,
                    assignees,
                });
            } catch (e) {
                core.warning(`Could not assign issue #${found.number}: ${e.message}`);
            }
        }
        core.warning(`Updated existing rotation issue #${found.number} (status: ${status}).`);
    } else {
        // Ensure the label exists (best-effort).
        try {
            await github.rest.issues.createLabel({
                owner,
                repo,
                name: 'pat-rotation',
                color: 'B60205',
                description: 'Approver PAT rotation tracking',
            });
        } catch (e) {
            // label likely already exists
        }
        const created = await github.rest.issues.create({
            owner,
            repo,
            title,
            body,
            labels: ['pat-rotation'],
            ...(assignees.length > 0 ? {assignees} : {}),
        });
        core.warning(
            `Opened rotation issue #${created.data.number} (status: ${status}, assignees: ${assignees.join(', ') || 'none'}).`,
        );
    }

    if (status === 'expired' || status === 'missing' || status === 'error') {
        core.setFailed(`PAT status is "${status}" — rotation required.`);
    }
};
