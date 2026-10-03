/** Workflow adapter; keeps reporting logic outside YAML. */
module.exports = async function ciGateReport(
    {github, context, core},
    env = process.env,
    files = require('node:fs'),
) {
    const fs = files;
    const path = require('path');

    const ORG = 'diplodoc-platform';
    const serverUrl = context.serverUrl || 'https://github.com';
    const runId = context.runId;
    const runUrl = `${serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${runId}`;

    /** @type {Map<string, string>} repo short name -> matrix job page URL */
    const jobUrlByRepo = new Map();
    try {
        const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
            owner: context.repo.owner,
            repo: context.repo.repo,
            run_id: runId,
            per_page: 100,
        });
        for (const job of jobs) {
            const match = /^Sync (.+)$/.exec(job.name || '');
            if (match && job.html_url) jobUrlByRepo.set(match[1], job.html_url);
        }
    } catch (err) {
        core.warning(`Could not list workflow jobs for run ${runId}: ${err.message}`);
    }

    const allRepos = JSON.parse(env.REPOS_JSON || '[]');
    const statusDir = '.status';
    const statuses = new Map();
    if (fs.existsSync(statusDir)) {
        for (const name of fs.readdirSync(statusDir)) {
            if (!name.startsWith('status-') || !name.endsWith('.json')) continue;
            try {
                const data = JSON.parse(fs.readFileSync(path.join(statusDir, name), 'utf8'));
                if (data && data.repo) statuses.set(data.repo, data);
            } catch (err) {
                core.warning(`Failed to parse ${name}: ${err.message}`);
            }
        }
    }

    const rows = allRepos.map((repo) => {
        const s = statuses.get(repo);
        if (!s) return {repo, status: 'failed', reason: 'no status artifact produced'};
        return s;
    });

    const icons = {
        created: '✅ Created',
        updated: '✅ Updated',
        unchanged: '✓ Unchanged',
        'dry-run': '🔎 Dry-run',
        skipped: '⊘ Skipped',
        failed: '❌ Failed',
    };

    const counts = {};
    for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;

    for (const r of rows) {
        const head = `[${r.repo}]`;
        const prot =
            r.protection_action && r.protection_action !== 'none'
                ? ` · protection: ${r.protection_action}`
                : '';
        if (r.status === 'created' || r.status === 'updated') {
            core.notice(`${head} ✅ ${r.status} — ${(r.contexts || []).length} context(s)${prot}`);
        } else if (r.status === 'unchanged') {
            core.notice(
                `${head} ✓ Unchanged — ${(r.contexts || []).length} context(s) already match${prot}`,
            );
        } else if (r.status === 'skipped') {
            core.notice(`${head} ⊘ Skipped — ${r.reason || 'no changes'}${prot}`);
        } else if (r.status === 'failed') {
            core.error(`${head} ❌ Failed — ${r.reason || 'unknown error'}`);
        }
        if (Array.isArray(r.collision_warnings) && r.collision_warnings.length) {
            for (const w of r.collision_warnings) {
                core.warning(
                    `${head} collision: "${w.context}" claimed by ${w.workflows.join(', ')} — give jobs distinct names`,
                );
            }
        }
    }

    const order = {failed: 0, skipped: 1, unchanged: 2, updated: 3, created: 4, 'dry-run': 5};
    rows.sort((a, b) => {
        const oa = order[a.status] ?? 99;
        const ob = order[b.status] ?? 99;
        if (oa !== ob) return oa - ob;
        return a.repo.localeCompare(b.repo);
    });

    const formatRow = (r) => {
        const status = icons[r.status] || r.status;
        const repoCell = `[${r.repo}](${serverUrl}/${ORG}/${r.repo})`;
        const jobUrl = jobUrlByRepo.get(r.repo) || runUrl;
        const actionCell = `[Sync job](${jobUrl})`;
        const action =
            r.action && r.action !== 'none'
                ? r.action
                : r.status === 'unchanged'
                  ? 'unchanged'
                  : '—';
        const prot =
            r.protection_action && r.protection_action !== 'none' ? r.protection_action : '—';
        const ctx = (r.contexts || []).length;
        const list = (r.contexts || []).length
            ? '<br>' + r.contexts.map((c) => `\`${c}\``).join('<br>')
            : '';
        const noteParts = [];
        if (r.reason) noteParts.push(r.reason);
        if (Array.isArray(r.collision_warnings) && r.collision_warnings.length) {
            for (const w of r.collision_warnings) {
                noteParts.push(
                    `⚠ collision: \`${w.context}\` in ${w.workflows.map((f) => `\`${f}\``).join(', ')}`,
                );
            }
        }
        const note = noteParts.join('<br>');
        return `| ${repoCell} | ${actionCell} | ${status} | ${action} | ${prot} | ${ctx}${list} | ${note} |`;
    };

    const lines = [
        '## CI gate sync summary',
        '',
        `Total: **${rows.length}** · 🔎 Dry-run: **${counts['dry-run'] || 0}** · ✅ Created: **${counts.created || 0}** · ✅ Updated: **${counts.updated || 0}** · ✓ Unchanged: **${counts.unchanged || 0}** · ⊘ Skipped: **${counts.skipped || 0}** · ❌ Failed: **${counts.failed || 0}**`,
        '',
        '| Repo | Job | Status | CI gate | Protection | Required contexts | Note |',
        '| --- | --- | --- | --- | --- | --- | --- |',
        ...rows.map(formatRow),
    ];

    await core.summary.addRaw(lines.join('\n')).write();

    if ((counts.failed || 0) > 0) {
        core.setFailed(`${counts.failed} repo(s) failed to sync. See the summary table above.`);
    }
};
