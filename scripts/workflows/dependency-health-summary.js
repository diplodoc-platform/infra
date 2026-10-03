/** Workflow adapter; keeps reporting logic outside YAML. */
module.exports = async function dependencyHealthSummary(
    {github, context, core},
    env = process.env,
    files = require('node:fs'),
) {
    const fs = files;
    let health;
    try {
        health = JSON.parse(fs.readFileSync('.status/dependency-health.json', 'utf8'));
    } catch (err) {
        core.warning(`Could not read health report: ${err.message}`);
    }
    let summary;
    try {
        summary = JSON.parse(fs.readFileSync('.status/dependency-summary.json', 'utf8'));
    } catch (err) {
        core.warning(`Could not read summary report: ${err.message}`);
    }
    const parts = [];
    if (health) {
        const s = health.summary || {};
        parts.push(
            `## Dependency Health Audit\n\n` +
                `- Total PRs: **${s.totalPrs ?? 0}**\n` +
                `- Breaching SLA: **${s.breachingPrs ?? 0}**\n` +
                `- Security PRs (breaching): **${s.securityPrs ?? 0}** (**${s.securityBreaching ?? 0}**)\n` +
                `- Critical-risk PRs (breaching): **${s.criticalPrs ?? 0}** (**${s.criticalBreaching ?? 0}**)\n` +
                `- Failing checks: **${s.failingPrs ?? 0}**\n` +
                `- Registry exceptions: **${s.totalExceptions ?? 0}** (expiring: ${s.expiringExceptions ?? 0}, overdue: ${s.overdueExceptions ?? 0})\n`,
        );
    }
    if (summary) {
        const t = summary.totals || {};
        parts.push(
            `## Daily Summary\n\n` +
                `- Actionable items: **${t.actionableItems ?? 0}**\n` +
                `- PRs without owner: **${t.prsWithoutOwner ?? 0}**\n` +
                `- Failing checks: **${t.failedChecks ?? 0}**\n` +
                `- SLA breaches: **${t.slaBreaches ?? 0}**\n` +
                `- Expiring exceptions: **${t.expiringExceptions ?? 0}**\n` +
                `- Unpinned versions: **${t.unpinnedVersions ?? 0}**\n` +
                `- Stale policy entries: **${t.stalePolicyEntries ?? 0}**\n` +
                `- Repos at PR limit: **${t.reposAtPrLimit ?? 0}**\n`,
        );
    }
    let assign;
    try {
        assign = JSON.parse(fs.readFileSync('.status/dependency-assign.json', 'utf8'));
    } catch (err) {
        core.warning(`Could not read assign report: ${err.message}`);
    }
    if (assign) {
        parts.push(
            `## Assignment Plan (T8.3)\n\n` +
                `- SLA-breaching PR assignment actions: **${(assign.actions || []).length}**\n` +
                (assign.issue
                    ? `- Tracking issue: #${assign.issue.number} (${assign.issue.created ? 'created' : 'updated'})\n`
                    : ''),
        );
    }
    if (parts.length > 0) {
        await core.summary.addRaw(parts.join('\n')).write();
    }
};
