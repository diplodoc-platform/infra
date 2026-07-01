#!/usr/bin/env node

/**
 * sync-ci-gate.js
 *
 * Discovers the actual set of CI status-check contexts produced by a target
 * repository and points its "master CI gate" ruleset (Ruleset A from ADR-002)
 * at exactly that set. This keeps the required_status_checks list in sync with
 * each repo's real workflows instead of a hand-maintained, org-wide flat list.
 *
 * It also ensures the check-independent protection gate (Ruleset B, ADR-001)
 * exists: create-only — an existing ruleset with that name is left untouched.
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
// Ruleset B from ADR-001: review/merge policy, independent of any status check.
const DEFAULT_PROTECTION_RULESET_NAME = 'master protection (auto-merge via app)';
const API_ROOT = 'https://api.github.com';
// Upper bound on matrix combinations we will expand in the workflow-parse
// fallback, to bound work on a hostile / pathological matrix definition.
const MAX_MATRIX_COMBINATIONS = 256;

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
 * Resolve the effective protection-gate (Ruleset B) config for a repo: global
 * `protection_gate` block overlaid with an optional per-repo override. This
 * ruleset is check-independent (review + merge policy); sync only *creates* it
 * when missing and never modifies a manually-tuned existing one.
 *
 * @param {object} config parsed distribution.yml
 * @param {string} repoName
 * @returns {{enabled: boolean, rulesetName: string, requiredApprovingReviewCount: number, requireCodeOwnerReview: boolean, dismissStaleReviewsOnPush: boolean, allowedMergeMethods: string[]}}
 */
function resolveProtectionConfig(config = {}, repoName) {
    const base = config.protection_gate || {};
    const rawOverride =
        config.repos && config.repos[repoName] && config.repos[repoName].protection_gate;
    const override = rawOverride && typeof rawOverride === 'object' ? rawOverride : {};
    const merged = {...base, ...override};

    return {
        enabled: merged.enabled !== undefined ? !!merged.enabled : true,
        rulesetName: merged.ruleset_name || DEFAULT_PROTECTION_RULESET_NAME,
        requiredApprovingReviewCount:
            merged.required_approving_review_count !== undefined
                ? merged.required_approving_review_count
                : 1,
        requireCodeOwnerReview:
            merged.require_code_owner_review !== undefined
                ? !!merged.require_code_owner_review
                : true,
        dismissStaleReviewsOnPush:
            merged.dismiss_stale_reviews_on_push !== undefined
                ? !!merged.dismiss_stale_reviews_on_push
                : false,
        allowedMergeMethods: merged.allowed_merge_methods || ['rebase', 'squash'],
    };
}

/**
 * Build the GitHub ruleset payload for the check-independent protection gate
 * (Ruleset B). The distribution App is added as a bypass actor (when its id is
 * known) so it can direct-merge hotfixes; auto-merge still needs a real approval.
 *
 * @param {object} params
 * @returns {object} body for POST /repos/{owner}/{repo}/rulesets
 */
function buildProtectionRulesetPayload({
    rulesetName,
    requiredApprovingReviewCount = 1,
    requireCodeOwnerReview = true,
    dismissStaleReviewsOnPush = false,
    allowedMergeMethods = ['rebase', 'squash'],
    appId = null,
}) {
    const bypassActors = [
        {actor_id: 1, actor_type: 'OrganizationAdmin', bypass_mode: 'always'},
    ];
    if (appId) {
        bypassActors.push({
            actor_id: Number(appId),
            actor_type: 'Integration',
            bypass_mode: 'always',
        });
    }

    return {
        name: rulesetName,
        target: 'branch',
        enforcement: 'active',
        conditions: {
            ref_name: {include: ['~DEFAULT_BRANCH'], exclude: []},
        },
        bypass_actors: bypassActors,
        rules: [
            {
                type: 'pull_request',
                parameters: {
                    required_approving_review_count: requiredApprovingReviewCount,
                    dismiss_stale_reviews_on_push: dismissStaleReviewsOnPush,
                    require_code_owner_review: requireCodeOwnerReview,
                    require_last_push_approval: false,
                    required_review_thread_resolution: false,
                    allowed_merge_methods: allowedMergeMethods,
                },
            },
            {type: 'deletion'},
            {type: 'non_fast_forward'},
        ],
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
 * Does a workflow `on:` trigger include `pull_request`? Handles the string,
 * array and mapping forms. (js-yaml may parse the bare `on:` key as the boolean
 * `true` under YAML 1.1 rules — callers should pass the resolved value.)
 *
 * @param {*} on
 * @returns {boolean}
 */
function workflowTriggersPr(on) {
    if (!on) return false;
    if (typeof on === 'string') return on === 'pull_request';
    if (Array.isArray(on)) return on.includes('pull_request');
    if (typeof on === 'object') {
        return Object.prototype.hasOwnProperty.call(on, 'pull_request');
    }
    return false;
}

function cartesian(arrays) {
    return arrays.reduce(
        (acc, arr) => acc.flatMap((prefix) => arr.map((value) => [...prefix, value])),
        [[]],
    );
}

/**
 * Compute the check-run context name(s) a single job produces, mirroring
 * GitHub's naming: base name is `job.name` (when static) else the job id; a
 * `strategy.matrix` expands to `base (v1, v2, ...)` over the cartesian product
 * of its array dimensions (in declaration order). `include`/`exclude` and
 * non-primitive / expression values are not expanded (best-effort; falls back
 * to the base name) — see the fallback caveats in ADR-002.
 *
 * @param {string} jobId
 * @param {object} job
 * @returns {string[]}
 */
function expandJobContexts(jobId, job = {}) {
    const base =
        typeof job.name === 'string' && !job.name.includes('${{') ? job.name : jobId;

    const matrix = job.strategy && job.strategy.matrix;
    if (!matrix || typeof matrix !== 'object') return [base];

    const dims = Object.entries(matrix)
        .filter(([key, value]) => key !== 'include' && key !== 'exclude' && Array.isArray(value))
        .map(([, value]) => value);
    if (dims.length === 0) return [base];

    const allPrimitive = dims.every((arr) =>
        arr.every((v) => ['string', 'number', 'boolean'].includes(typeof v)),
    );
    if (!allPrimitive) return [base];

    // Guard against a crafted workflow whose matrix cartesian product explodes
    // (memory/CPU DoS on the sync job). Well past any realistic real matrix.
    const combinations = dims.reduce((acc, arr) => acc * arr.length, 1);
    if (combinations > MAX_MATRIX_COMBINATIONS) return [base];

    return cartesian(dims).map((combo) => `${base} (${combo.map(String).join(', ')})`);
}

/**
 * Derive check-run context names from a parsed workflow document, but only for
 * workflows that run on `pull_request` (the ones that gate a PR).
 *
 * @param {object} doc parsed workflow YAML
 * @returns {string[]}
 */
function contextsFromWorkflowDoc(doc = {}) {
    // Under YAML 1.1, js-yaml can turn the `on:` key into the boolean `true`.
    const onField = doc.on !== undefined ? doc.on : doc[true];
    if (!workflowTriggersPr(onField)) return [];

    const jobs = doc.jobs || {};
    const out = [];
    for (const [jobId, job] of Object.entries(jobs)) {
        for (const ctx of expandJobContexts(jobId, job || {})) out.push(ctx);
    }
    return out;
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

/**
 * Fallback discovery for repos with no CI runs yet (e.g. a brand-new repo where
 * scaffolding was just pushed): read the workflow YAML files on the default
 * branch and derive the PR check contexts statically.
 */
async function discoverContextsFromWorkflows(token, owner, name, ref) {
    let listing;
    try {
        listing = await ghRequest(
            token,
            'GET',
            `/repos/${owner}/${name}/contents/.github/workflows?ref=${encodeURIComponent(ref)}`,
        );
    } catch {
        return [];
    }
    if (!Array.isArray(listing)) return [];

    const files = listing.filter(
        (f) => f && f.type === 'file' && /\.ya?ml$/i.test(f.name || ''),
    );

    const names = new Set();
    for (const file of files) {
        let doc;
        try {
            const item = await ghRequest(
                token,
                'GET',
                `/repos/${owner}/${name}/contents/${encodeURIComponent(file.path)}?ref=${encodeURIComponent(ref)}`,
            );
            const content =
                item && item.content
                    ? Buffer.from(item.content, item.encoding || 'base64').toString('utf8')
                    : '';
            doc = yaml.load(content) || {};
        } catch {
            continue;
        }
        for (const ctx of contextsFromWorkflowDoc(doc)) names.add(ctx);
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

async function syncCiGate({token, owner, name, gate, protection, appId, dryRun}) {
    const result = {
        repo: name,
        ruleset_name: gate.rulesetName,
        status: 'skipped',
        action: 'none',
        protection_action: 'none',
        contexts: [],
    };

    const defaultBranch = await getDefaultBranch(token, owner, name);
    result.default_branch = defaultBranch;

    let contexts;
    if (gate.requiredChecks) {
        contexts = filterChecks(gate.requiredChecks, []);
        result.source = 'config';
    } else {
        let discovered = [];
        try {
            discovered = await discoverContexts(token, owner, name, defaultBranch);
        } catch (error) {
            // e.g. an empty repo with no HEAD commit — fall through to parsing.
            result.discover_error = error.message;
        }
        contexts = filterChecks(discovered, gate.excludeChecks);
        result.source = 'discovery';
        result.discovered_count = discovered.length;

        // New repo / no CI runs yet: nothing reported any check-run. Fall back to
        // parsing the workflow files so the gate is populated from day one; the
        // daily sync then replaces these with real discovered contexts once CI runs.
        if (contexts.length === 0) {
            let parsed = [];
            try {
                parsed = await discoverContextsFromWorkflows(token, owner, name, defaultBranch);
            } catch (error) {
                result.parse_error = error.message;
            }
            const parsedContexts = filterChecks(parsed, gate.excludeChecks);
            if (parsedContexts.length > 0) {
                contexts = parsedContexts;
                result.source = 'workflow-parse';
                result.parsed_count = parsed.length;
            }
        }
    }
    result.contexts = contexts;

    const protectionEnabled = protection && protection.enabled;

    if (dryRun) {
        result.status = contexts.length ? 'dry-run' : 'skipped';
        if (!contexts.length) {
            result.reason =
                'no CI contexts discovered after filtering — CI gate left untouched';
        }
        result.protection_action = protectionEnabled ? 'planned-if-missing' : 'disabled';
        return result;
    }

    // Fetch the ruleset list once; used for both gates.
    const existing = await listRulesets(token, owner, name);

    // Ensure the check-independent protection gate (Ruleset B) exists. Create
    // only — never modify an existing (possibly hand-tuned) ruleset.
    if (protectionEnabled) {
        const prot = selectRulesetAction(existing, protection.rulesetName);
        if (prot.method === 'POST') {
            await ghRequest(
                token,
                'POST',
                `/repos/${owner}/${name}/rulesets`,
                buildProtectionRulesetPayload({...protection, appId}),
            );
            result.protection_action = 'created';
        } else {
            result.protection_action = 'exists';
        }
    } else {
        result.protection_action = 'disabled';
    }

    // CI gate (Ruleset A): create/update to the discovered contexts.
    if (contexts.length === 0) {
        result.status = 'skipped';
        result.reason = 'no CI contexts discovered after filtering — CI gate left untouched';
        return result;
    }

    const {method, id} = selectRulesetAction(existing, gate.rulesetName);
    const path =
        method === 'PUT'
            ? `/repos/${owner}/${name}/rulesets/${id}`
            : `/repos/${owner}/${name}/rulesets`;

    await ghRequest(
        token,
        method,
        path,
        buildRulesetPayload({rulesetName: gate.rulesetName, contexts}),
    );

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
    const protection = resolveProtectionConfig(config, name);
    const appId = process.env.INFRA_APP_ID || null;

    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (!token && !dryRun) {
        throw new Error('GH_TOKEN env var is required (token with Administration: write)');
    }

    let result;
    try {
        result = await syncCiGate({token, owner, name, gate, protection, appId, dryRun});
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
    resolveProtectionConfig,
    buildRulesetPayload,
    buildProtectionRulesetPayload,
    selectRulesetAction,
    workflowTriggersPr,
    expandJobContexts,
    contextsFromWorkflowDoc,
    parseRepo,
    syncCiGate,
};
