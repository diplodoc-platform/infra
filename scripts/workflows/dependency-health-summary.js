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
    const incomplete = (report) => report.complete === false || report.errors?.length > 0;
    const count = (report, value) => (incomplete(report) ? 'UNKNOWN' : (value ?? 0));
    const auditWarning = (report, label) => {
        if (!incomplete(report)) return '';
        core.warning(`${label} is incomplete; counts are UNKNOWN, not all clear`);
        return (
            '**Incomplete audit: counts are UNKNOWN, not all clear. See uploaded reports.**\n\n' +
            (report.errors || [])
                .map((error) => `- ${error.repo}: ${error.phase} — ${error.message}`)
                .join('\n') +
            '\n\n'
        );
    };
    if (health) {
        const s = health.summary || {};
        parts.push(
            `## Dependency Health Audit\n\n` +
                auditWarning(health, 'Dependency health audit') +
                `- Total PRs: **${count(health, s.totalPrs)}**\n` +
                `- Breaching SLA: **${count(health, s.breachingPrs)}**\n` +
                `- Security PRs (breaching): **${count(health, s.securityPrs)}** (**${count(health, s.securityBreaching)}**)\n` +
                `- Critical-risk PRs (breaching): **${count(health, s.criticalPrs)}** (**${count(health, s.criticalBreaching)}**)\n` +
                `- Failing checks: **${count(health, s.failingPrs)}**\n` +
                `- Registry exceptions: **${count(health, s.totalExceptions)}** (expiring: ${count(health, s.expiringExceptions)}, overdue: ${count(health, s.overdueExceptions)})\n`,
        );
    }
    if (summary) {
        const t = summary.totals || {};
        parts.push(
            `## Daily Summary\n\n` +
                auditWarning(summary, 'Daily dependency summary') +
                `- Actionable items: **${count(summary, t.actionableItems)}**\n` +
                `- PRs without owner: **${count(summary, t.prsWithoutOwner)}**\n` +
                `- Failing checks: **${count(summary, t.failedChecks)}**\n` +
                `- SLA breaches: **${count(summary, t.slaBreaches)}**\n` +
                `- Expiring exceptions: **${count(summary, t.expiringExceptions)}**\n` +
                `- Unpinned versions: **${count(summary, t.unpinnedVersions)}**\n` +
                `- Stale policy entries: **${count(summary, t.stalePolicyEntries)}**\n` +
                `- Repos at PR limit: **${count(summary, t.reposAtPrLimit)}**\n`,
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
                auditWarning(assign, 'Owner assignment audit') +
                `- SLA-breaching PR assignment actions: **${count(assign, (assign.actions || []).length)}**\n` +
                (assign.issue
                    ? `- Tracking issue: #${assign.issue.number} (${assign.issue.created ? 'created' : 'updated'})\n`
                    : ''),
        );
    }
    if (parts.length > 0) {
        await core.summary.addRaw(parts.join('\n')).write();
    }
};
