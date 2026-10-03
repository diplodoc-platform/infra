/** Workflow adapter; keeps reporting logic outside YAML. */
module.exports = async function distributionReport(
    {github, context, core},
    env = process.env,
    files = require('node:fs'),
) {
    const fs = files;
    const path = require('path');

    const version = env.VERSION || '';
    const allRepos = JSON.parse(env.REPOS_JSON || '[]');

    // Read every status-<repo>.json file downloaded into .status/
    const statusDir = '.status';
    const statuses = new Map(); // repo -> payload
    if (fs.existsSync(statusDir)) {
        for (const name of fs.readdirSync(statusDir)) {
            if (!name.startsWith('status-') || !name.endsWith('.json')) continue;
            try {
                const raw = fs.readFileSync(path.join(statusDir, name), 'utf8');
                const data = JSON.parse(raw);
                if (data && data.repo) statuses.set(data.repo, data);
            } catch (err) {
                core.warning(`Failed to parse ${name}: ${err.message}`);
            }
        }
    }

    // Repos that ended without any status artifact at all are treated
    // as failed (typically: matrix cell crashed before reaching the
    // "Write status artifact payload" step, or upload failed).
    const rows = allRepos.map((repo) => {
        const s = statuses.get(repo);
        if (!s) {
            return {
                repo,
                status: 'failed',
                reason: 'no status artifact produced',
            };
        }
        return s;
    });

    const fmtDuration = (s) => {
        if (typeof s !== 'number' || !Number.isFinite(s) || s < 0) return '—';
        const m = Math.floor(s / 60);
        const sec = s % 60;
        return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
    };

    const icons = {
        updated: '✅ Updated',
        skipped: '⊘ Skipped',
        failed: '❌ Failed',
    };

    const counts = {updated: 0, skipped: 0, failed: 0};
    for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;

    // Per-repo annotations for quick UI scanning.
    for (const r of rows) {
        const head = `[${r.repo}]`;
        if (r.status === 'updated') {
            const pr = r.pr_url ? ` — ${r.pr_url}` : '';
            const am =
                r.auto_merge === 'true'
                    ? r.auto_merge_enabled === 'true'
                        ? ' (auto-merge enabled)'
                        : ' (auto-merge requested but not enabled)'
                    : '';
            core.notice(`${head} ✅ Updated${pr}${am}`);
        } else if (r.status === 'skipped') {
            core.notice(`${head} ⊘ Skipped — no scaffolding changes`);
        } else {
            const reason = r.reason ? ` — ${r.reason}` : '';
            core.error(`${head} ❌ Failed${reason}`);
        }
    }

    // Sort: failed first, then updated, then skipped — alpha within group.
    const order = {failed: 0, updated: 1, skipped: 2};
    rows.sort((a, b) => {
        const oa = order[a.status] ?? 99;
        const ob = order[b.status] ?? 99;
        if (oa !== ob) return oa - ob;
        return a.repo.localeCompare(b.repo);
    });

    const fmtMerge = (r) => {
        // Reflect the actual post-poll merge state of the PR, not just
        // whether auto-merge was requested. See "Poll merge state for
        // distributed PRs" step above for the source of these fields.
        const s = r.pr_state || '';
        const ms = r.pr_merge_state || '';
        if (s === 'MERGED') return '✅ merged';
        if (s === 'CLOSED') return '🚫 closed';
        if (ms === 'BLOCKED') return '⛔ blocked';
        if (ms === 'DIRTY') return '⚠️ dirty';
        if (ms === 'UNSTABLE') return '🟡 unstable';
        if (ms === 'BEHIND') return '⏳ behind';
        if (ms === 'CLEAN' || ms === 'HAS_HOOKS') return '⏳ pending';
        if (s === 'OPEN') return '⏳ open';
        return '—';
    };

    const formatRow = (r) => {
        const status = icons[r.status] || r.status;
        const pr = r.pr_url ? `[#${r.pr_number || '?'}](${r.pr_url})` : '—';
        let am = '—';
        if (r.auto_merge === 'true') {
            am = r.auto_merge_enabled === 'true' ? '✅ enabled' : '⚠️ requested';
        } else if (r.auto_merge === 'false') {
            am = 'off';
        }
        const merge = fmtMerge(r);
        const dur = fmtDuration(r.duration_s);
        return `| \`${r.repo}\` | ${status} | ${pr} | ${am} | ${merge} | ${dur} |`;
    };

    const title = version ? `Distribution summary — ${version}` : 'Distribution summary';

    const lines = [
        `## ${title}`,
        '',
        `Total: **${rows.length}** · ✅ Updated: **${counts.updated || 0}** · ⊘ Skipped: **${counts.skipped || 0}** · ❌ Failed: **${counts.failed || 0}**`,
        '',
        '| Repo | Status | PR | Auto-merge | Merge state | Duration |',
        '| --- | --- | --- | --- | --- | --- |',
        ...rows.map(formatRow),
    ];

    await core.summary.addRaw(lines.join('\n')).write();

    if ((counts.failed || 0) > 0) {
        core.setFailed(
            `${counts.failed} repo(s) failed to distribute. See the summary table above.`,
        );
    }
};
