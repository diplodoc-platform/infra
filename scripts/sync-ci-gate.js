#!/usr/bin/env node

/**
 * sync-ci-gate.js
 *
 * Discovers the actual set of CI status-check contexts produced by a target
 * repository and points its "master CI gate" ruleset (Ruleset A from ADR-002)
 * at exactly that set. This keeps the required_status_checks list in sync with
 * each repo's real workflows instead of a hand-maintained, org-wide flat list.
 *
 * Discovery source: the check-runs and legacy commit statuses of the HEAD commit
 * on the default branch. Workflows that fire on `push` to the default branch
 * (tests.yml, security.yml) appear there; non-PR / conditional jobs are removed
 * via the `ci_gate.exclude_checks` glob list so a PR never blocks forever on a
 * check that does not report on every PR.
 *
 * Runnable two ways:
 *   - As a CLI:   node scripts/sync-ci-gate.js --repo <name|owner/name> [--config <path>] [--dry-run] [--output <file>]
 *   - As a module: require('./sync-ci-gate') -> exposes pure helpers for tests.
 *
 * Auth: needs a token with `Administration: write` on the target repo, supplied
 * via the GH_TOKEN env var (GitHub App installation token in CI).
 */

const {readFileSync, writeFileSync, existsSync, mkdirSync} = require('node:fs');
const {dirname, resolve} = require('node:path');
const yaml = require('js-yaml');

const DEFAULT_OWNER = 'diplodoc-platform';
const DEFAULT_RULESET_NAME = 'master CI gate';
const API_ROOT = 'https://api.github.com';

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests — no network, no process state)
// ---------------------------------------------------------------------------

/**
 * Match a check-run name against a single glob pattern.
 * Only `*` is special and matches any run of characters (including spaces,
 * parentheses and slashes, which legitimately occur in check names like
 * "test (ubuntu-latest, 24)"). The match is anchored (full string).
 *
 * @param {string} name
 * @param {string} pattern
 * @returns {boolean}
 */
function matchesGlob(name, pattern) {
    const regexStr = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${regexStr}$`).test(name);
}

/**
 * Remove excluded check names and return a sorted, de-duplicated list.
 *
 * @param {string[]} names raw discovered check/status names
 * @param {string[]} excludePatterns glob patterns to drop
 * @returns {string[]}
 */
function filterChecks(names, excludePatterns = []) {
    const seen = new Set();
    for (const raw of names) {
        const name = typeof raw === 'string' ? raw.trim() : '';
        if (!name) continue;
        if (excludePatterns.some((pattern) => matchesGlob(name, pattern))) continue;
        seen.add(name);
    }
    return [...seen].sort((a, b) => a.localeCompare(b));
}

/**
 * Resolve the effective ci_gate config for a repo: global `ci_gate` block,
 * overlaid with an optional per-repo `repos.<name>.ci_gate` override.
 *
 * @param {object} config parsed distribution.yml
 * @param {string} repoName short repo name (key in repos:)
 * @returns {{rulesetName: string, excludeChecks: string[], requiredChecks: (string[]|null)}}
 */
function resolveGateConfig(config = {}, repoName) {
    const base = config.ci_gate || {};
    const override = (config.repos && config.repos[repoName] && config.repos[repoName].ci_gate) || {};

    return {
        rulesetName: override.ruleset_name || base.ruleset_name || DEFAULT_RULESET_NAME,
        excludeChecks:
            override.exclude_checks !== undefined
                ? override.exclude_checks
                : base.exclude_checks || [],
        // Explicit pin: when provided, discovery is skipped entirely.
        requiredChecks:
            override.required_checks !== undefined ? override.required_checks : null,
    };
}

/**
 * Build the GitHub ruleset payload for the CI gate.
 *
 * @param {{rulesetName: string, contexts: string[]}} params
 * @returns {object} body for POST/PUT /repos/{owner}/{repo}/rulesets
 */
function buildRulesetPayload({rulesetName, contexts}) {
    return {
        name: rulesetName,
        target: 'branch',
        enforcement: 'active',
        conditions: {
            ref_name: {include: ['~DEFAULT_BRANCH'], exclude: []},
        },
        bypass_actors: [
            {actor_id: 1, actor_type: 'OrganizationAdmin', bypass_mode: 'always'},
        ],
        rules: [
            {
                type: 'required_status_checks',
                parameters: {
                    strict_required_status_checks_policy: false,
                    required_status_checks: contexts.map((context) => ({context})),
                },
            },
        ],
    };
}

/**
 * Decide whether to create or update the ruleset given the existing list.
 * Matches by exact name (case-insensitive to be forgiving of manual edits).
 *
 * @param {Array<{id: number, name: string}>} rulesets
 * @param {string} rulesetName
 * @returns {{method: 'POST'|'PUT', id: (number|null)}}
 */
function selectRulesetAction(rulesets = [], rulesetName) {
    const wanted = rulesetName.toLowerCase();
    const found = rulesets.find(
        (rs) => typeof rs.name === 'string' && rs.name.toLowerCase() === wanted,
    );
    return found ? {method: 'PUT', id: found.id} : {method: 'POST', id: null};
}

/**
 * Split a `--repo` value (either "name" or "owner/name") into parts.
 *
 * @param {string} repoArg
 * @param {string} [defaultOwner]
 * @returns {{owner: string, name: string}}
 */
// GitHub owner/repo names: letters, digits, '.', '_', '-'. Anchored full match.
// Guards against path traversal / injection when interpolated into API URLs.
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

function assertSafeSegment(value, label) {
    if (!SAFE_SEGMENT.test(value) || value === '.' || value === '..') {
        throw new Error(`invalid ${label} "${value}" (allowed: A-Z a-z 0-9 . _ -)`);
    }
    return value;
}

function parseRepo(repoArg, defaultOwner = DEFAULT_OWNER) {
    if (!repoArg) throw new Error('repo is required');
    if (repoArg.includes('/')) {
        const [owner, name] = repoArg.split('/');
        return {
            owner: assertSafeSegment(owner, 'owner'),
            name: assertSafeSegment(name, 'repo'),
        };
    }
    return {
        owner: assertSafeSegment(defaultOwner, 'owner'),
        name: assertSafeSegment(repoArg, 'repo'),
    };
}

// ---------------------------------------------------------------------------
// GitHub API layer (thin wrapper around fetch)
// ---------------------------------------------------------------------------

async function ghRequest(token, method, path, body) {
    const res = await fetch(`${API_ROOT}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'diplodoc-infra-sync-ci-gate',
            ...(body ? {'Content-Type': 'application/json'} : {}),
        },
        ...(body ? {body: JSON.stringify(body)} : {}),
    });

    const text = await res.text();
    let json = null;
    if (text) {
        try {
            json = JSON.parse(text);
        } catch {
            json = null;
        }
    }

    if (!res.ok) {
        const detail = json && json.message ? json.message : text || res.statusText;
        throw new Error(`GitHub API ${method} ${path} -> ${res.status}: ${detail}`);
    }
    return json;
}

async function getDefaultBranch(token, owner, name) {
    const repo = await ghRequest(token, 'GET', `/repos/${owner}/${name}`);
    return repo.default_branch;
}

async function discoverContexts(token, owner, name, ref) {
    const names = new Set();

    // 1) GitHub Checks API (workflow jobs, with matrix expansion in the name).
    let page = 1;
    for (;;) {
        const data = await ghRequest(
            token,
            'GET',
            `/repos/${owner}/${name}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100&page=${page}`,
        );
        const runs = (data && data.check_runs) || [];
        for (const run of runs) {
            if (run && run.name) names.add(run.name);
        }
        const total = (data && data.total_count) || 0;
        if (runs.length === 0 || page * 100 >= total) break;
        page++;
    }

    // 2) Legacy commit statuses (e.g. external integrations posting via the
    //    Status API rather than the Checks API).
    const status = await ghRequest(
        token,
        'GET',
        `/repos/${owner}/${name}/commits/${encodeURIComponent(ref)}/status`,
    );
    for (const s of (status && status.statuses) || []) {
        if (s && s.context) names.add(s.context);
    }

    return [...names];
}

async function listRulesets(token, owner, name) {
    const data = await ghRequest(
        token,
        'GET',
        `/repos/${owner}/${name}/rulesets?per_page=100&includes_parents=false`,
    );
    return Array.isArray(data) ? data : [];
}

// ---------------------------------------------------------------------------
// CLI orchestration
// ---------------------------------------------------------------------------

function parseFlags(argv) {
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
        if (!argv[i].startsWith('--')) continue;
        const key = argv[i].slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
            flags[key] = next;
            i++;
        } else {
            flags[key] = true;
        }
    }
    return flags;
}

function loadConfig(configPath) {
    if (!configPath || !existsSync(configPath)) return {};
    return yaml.load(readFileSync(configPath, 'utf8')) || {};
}

async function syncCiGate({token, owner, name, gate, dryRun}) {
    const result = {
        repo: name,
        ruleset_name: gate.rulesetName,
        status: 'skipped',
        action: 'none',
        contexts: [],
    };

    const defaultBranch = await getDefaultBranch(token, owner, name);
    result.default_branch = defaultBranch;

    let contexts;
    if (gate.requiredChecks) {
        contexts = filterChecks(gate.requiredChecks, []);
        result.source = 'config';
    } else {
        const discovered = await discoverContexts(token, owner, name, defaultBranch);
        contexts = filterChecks(discovered, gate.excludeChecks);
        result.source = 'discovery';
        result.discovered_count = discovered.length;
    }
    result.contexts = contexts;

    if (contexts.length === 0) {
        result.status = 'skipped';
        result.reason = 'no CI contexts discovered after filtering — gate left untouched';
        return result;
    }

    const payload = buildRulesetPayload({rulesetName: gate.rulesetName, contexts});

    if (dryRun) {
        result.status = 'dry-run';
        return result;
    }

    const existing = await listRulesets(token, owner, name);
    const {method, id} = selectRulesetAction(existing, gate.rulesetName);
    const path =
        method === 'PUT'
            ? `/repos/${owner}/${name}/rulesets/${id}`
            : `/repos/${owner}/${name}/rulesets`;

    await ghRequest(token, method, path, payload);

    result.status = 'synced';
    result.action = method === 'PUT' ? 'updated' : 'created';
    return result;
}

function writeOutput(outputFile, result) {
    if (!outputFile) return;
    const abs = resolve(outputFile);
    mkdirSync(dirname(abs), {recursive: true});
    writeFileSync(abs, JSON.stringify(result, null, 2), 'utf8');
}

async function main() {
    const flags = parseFlags(process.argv.slice(2));
    const dryRun = !!flags['dry-run'];
    const outputFile = typeof flags.output === 'string' ? flags.output : null;

    const repoArg = flags.repo || process.env.REPO || process.env.REPO_NAME;
    const {owner, name} = parseRepo(repoArg, process.env.REPO_OWNER || DEFAULT_OWNER);

    const configPath = resolve(flags.config || 'distribution.yml');
    const config = loadConfig(configPath);
    const gate = resolveGateConfig(config, name);

    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (!token && !dryRun) {
        throw new Error('GH_TOKEN env var is required (token with Administration: write)');
    }

    let result;
    try {
        result = await syncCiGate({token, owner, name, gate, dryRun});
    } catch (error) {
        result = {
            repo: name,
            ruleset_name: gate.rulesetName,
            status: 'failed',
            reason: error.message,
            contexts: [],
        };
    }

    // Human-readable summary -> stderr; machine result -> stdout.
    console.error(
        `[ci-gate] ${name}: ${result.status}` +
            (result.action && result.action !== 'none' ? ` (${result.action})` : '') +
            (result.contexts ? ` — ${result.contexts.length} context(s)` : '') +
            (result.reason ? ` — ${result.reason}` : ''),
    );
    if (result.contexts && result.contexts.length > 0) {
        for (const c of result.contexts) console.error(`    • ${c}`);
    }
    console.log(JSON.stringify(result));
    writeOutput(outputFile, result);

    if (result.status === 'failed') process.exit(1);
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`[ci-gate] fatal: ${error.message}`);
        process.exit(1);
    });
}

module.exports = {
    matchesGlob,
    filterChecks,
    resolveGateConfig,
    buildRulesetPayload,
    selectRulesetAction,
    parseRepo,
    syncCiGate,
};
