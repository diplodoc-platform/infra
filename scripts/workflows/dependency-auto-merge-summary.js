/** Workflow adapter; keeps reporting logic outside YAML. */
module.exports = async function dependencyAutoMergeSummary(
    {github, context, core},
    env = process.env,
    files = require('node:fs'),
) {
    const fs = files;
    let audit;
    try {
        audit = JSON.parse(fs.readFileSync('.status/auto-merge-audit.json', 'utf8'));
    } catch (err) {
        core.warning(`Could not read audit log: ${err.message}`);
        return;
    }
    if (!Array.isArray(audit)) return;
    const total = audit.length;
    const allowed = audit.filter((e) => e.allowed).length;
    const merged = audit.filter((e) => e.merged).length;
    const errors = audit.filter((e) => e.mergeError).length;
    const skipped = audit.filter((e) => e.skipped).length;
    const mode = 'DRY-RUN (audit only)';
    await core.summary
        .addRaw(
            `## Dependency Auto-merge (${mode})\n\n` +
                `- Total evaluated: **${total}**\n` +
                `- Allowed: **${allowed}**\n` +
                `- Merged: **${merged}**\n` +
                `- Merge errors: **${errors}**\n` +
                `- Skipped (dry-run): **${skipped}**\n`,
        )
        .write();
};
