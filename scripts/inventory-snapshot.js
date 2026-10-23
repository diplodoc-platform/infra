'use strict';

const {readFileSync, lstatSync} = require('node:fs');
const {exportInventory} = require('./export-pr-inventory');

const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;

/** Bind a shared audit snapshot to the exact repository scope and check mode. */
function validateSnapshot(snapshot, {owner, repos, skipChecks = false}) {
    const expectedRepos = [...new Set(repos)].sort();
    if (
        !snapshot ||
        snapshot.schema !== 1 ||
        snapshot.owner !== owner ||
        JSON.stringify(snapshot.repositories) !== JSON.stringify(expectedRepos) ||
        snapshot.skipChecks !== skipChecks ||
        !Number.isFinite(Date.parse(snapshot.capturedAt)) ||
        !Array.isArray(snapshot.inventory) ||
        !Array.isArray(snapshot.errors)
    ) {
        throw new Error('Invalid inventory snapshot or mismatched audit scope');
    }

    const seen = new Set();
    for (const pr of snapshot.inventory) {
        if (
            !pr ||
            !expectedRepos.includes(pr.repo) ||
            !Number.isSafeInteger(pr.number) ||
            pr.number <= 0 ||
            !Number.isFinite(Date.parse(pr.createdAt)) ||
            !Number.isFinite(pr.ageDays) ||
            pr.ageDays < 0 ||
            typeof pr.security !== 'boolean' ||
            !Array.isArray(pr.assignees) ||
            pr.assignees.some((login) => typeof login !== 'string' || !login) ||
            !['low', 'medium', 'high', 'critical', 'unknown'].includes(pr.risk) ||
            !['patch', 'minor', 'major', 'unknown'].includes(pr.updateType) ||
            !['passing', 'failing', 'pending', 'unknown'].includes(pr.checkStatus) ||
            seen.has(`${pr.repo}#${pr.number}`)
        ) {
            throw new Error('Invalid or duplicate PR in inventory snapshot');
        }
        seen.add(`${pr.repo}#${pr.number}`);
    }
    if (
        snapshot.errors.some(
            (error) =>
                !error ||
                !expectedRepos.includes(error.repo) ||
                typeof error.phase !== 'string' ||
                typeof error.message !== 'string',
        )
    ) {
        throw new Error('Invalid errors in inventory snapshot');
    }

    return snapshot;
}

function readSnapshot(filePath, scope) {
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES) {
        throw new Error('Inventory snapshot must be a regular JSON file smaller than 16 MiB');
    }

    return validateSnapshot(JSON.parse(readFileSync(filePath, 'utf8')), scope);
}

/** Fetch once by default; reuse an explicitly supplied, validated snapshot. */
async function auditInventory({snapshot, now, ...params}) {
    if (snapshot) return validateSnapshot(snapshot, params);

    const result = await exportInventory(params);
    return validateSnapshot(
        {
            schema: 1,
            owner: params.owner,
            repositories: [...new Set(params.repos)].sort(),
            skipChecks: params.skipChecks === true,
            capturedAt: (now || new Date()).toISOString(),
            inventory: result.inventory,
            errors: result.errors,
        },
        params,
    );
}

module.exports = {validateSnapshot, readSnapshot, auditInventory};
