'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const {createHash} = require('node:crypto');

const OWNER = 'diplodoc-platform';
const SHA = /^[a-f0-9]{40}$/;
const REPO = /^[a-z0-9][a-z0-9-]*$/;
const SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const digest = (data) => createHash('sha256').update(data).digest('hex');
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');

function planId(plan) {
    return digest(
        JSON.stringify({
            tool: plan.toolSha,
            meta: plan.metapackageSha,
            cli: plan.cli.sha,
            readyBy: plan.readyBy,
            selected: plan.selected.map(({repo, number, sha, baseSha}) => ({
                repo,
                number,
                sha,
                baseSha,
            })),
        }),
    ).slice(0, 16);
}

function validatePlan(plan) {
    assert.equal(plan.schema, 1);
    assert.match(plan.toolSha, SHA);
    assert.match(plan.metapackageSha, SHA);
    assert.match(plan.cli.sha, SHA);
    assert.equal(plan.cli.repo, 'cli');
    assert.ok(Number.isFinite(Date.parse(plan.readyBy)), 'Missing 08:00 Moscow readiness target');
    assert.ok(Array.isArray(plan.selected) && plan.selected.length <= 3);
    assert.ok(Array.isArray(plan.graph) && plan.graph.length <= 40);

    for (const item of [...plan.graph, ...plan.selected]) {
        assert.match(item.repo, REPO);
        assert.match(item.sha, SHA);
        assert.match(item.manifest.name, /^(?:@[a-z0-9][a-z0-9-]*\/)?[a-z0-9][a-z0-9._-]*$/);
    }
    assert.equal(new Set(plan.graph.map((item) => item.repo)).size, plan.graph.length);
    assert.equal(new Set(plan.graph.map((item) => item.manifest.name)).size, plan.graph.length);
    assert.deepEqual(
        plan.cli,
        plan.graph.find((item) => item.repo === 'cli'),
    );

    for (const item of plan.selected) {
        assert.ok(Number.isSafeInteger(item.number) && item.number > 0);
        assert.match(item.baseSha, SHA);
        assert.ok(plan.graph.some((node) => node.repo === item.repo && node.sha === item.sha));
    }
    assert.equal(plan.id, planId(plan));
    return plan;
}

async function github(route, {token = process.env.GH_TOKEN, method = 'GET', body} = {}) {
    assert.ok(route.startsWith('/repos/') || route === '/user');
    const response = await fetch(`https://api.github.com${route}`, {
        method,
        headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'diplodoc-infra-candidate-train',
            ...(token ? {Authorization: `Bearer ${token}`} : {}),
            'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
        const error = new Error(`GitHub ${method} ${route.split('?')[0]}: HTTP ${response.status}`);
        error.status = response.status;
        throw error;
    }
    return response.status === 204 ? null : response.json();
}

async function pages(route, request = github) {
    const result = [];
    for (let page = 1; page <= 20; page++) {
        const data = await request(
            `${route}${route.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
        );
        assert.ok(Array.isArray(data), 'Expected a complete API array');
        result.push(...data);
        if (data.length < 100) return result;
    }
    throw new Error('API pagination limit exceeded');
}

async function fileAt(repo, sha, file, request = github) {
    assert.match(repo, REPO);
    assert.match(sha, SHA);
    assert.ok(['package.json', 'package-lock.json', '.gitmodules'].includes(file));
    const prefix = `/repos/${OWNER}/${repo}`;
    const tree = await request(`${prefix}/git/trees/${sha}`);
    assert.equal(tree.truncated, false);
    const entry = tree.tree.find((item) => item.path === file && item.type === 'blob');
    assert.ok(entry, `Missing ${repo}/${file}`);
    const blob = await request(`${prefix}/git/blobs/${entry.sha}`);
    assert.equal(blob.encoding, 'base64');
    assert.ok(blob.size < 8 * 1024 * 1024, 'Source metadata is too large');
    return Buffer.from(blob.content.replace(/\s/g, ''), 'base64').toString('utf8');
}

function buildOrder(graph, selected) {
    const byName = new Map(graph.map((item) => [item.manifest.name, item]));
    const edges = (item) =>
        Object.keys({
            ...item.manifest.dependencies,
            ...item.manifest.optionalDependencies,
            ...(item.repo === 'client' ? item.manifest.devDependencies : {}),
        }).filter((name) => byName.has(name));
    const reachable = new Set();
    const visit = (name) => {
        if (reachable.has(name)) return;
        reachable.add(name);
        edges(byName.get(name)).forEach(visit);
    };
    assert.ok(byName.has('@diplodoc/cli'));
    visit('@diplodoc/cli');

    const affected = new Set(selected.map((item) => item.manifest.name));
    for (const name of affected)
        assert.ok(reachable.has(name), `${name} is not in the CLI build graph`);
    let changed = true;
    while (changed) {
        changed = false;
        for (const item of graph) {
            if (
                reachable.has(item.manifest.name) &&
                !affected.has(item.manifest.name) &&
                edges(item).some((name) => affected.has(name))
            ) {
                affected.add(item.manifest.name);
                changed = true;
            }
        }
    }
    const ordered = [];
    const active = new Set();
    const done = new Set();
    function sort(name) {
        if (done.has(name) || !affected.has(name)) return;
        assert.ok(!active.has(name), 'Affected build graph contains a cycle');
        active.add(name);
        edges(byName.get(name)).forEach(sort);
        active.delete(name);
        done.add(name);
        ordered.push(byName.get(name));
    }
    sort('@diplodoc/cli');
    assert.equal(done.size, affected.size, 'An affected package does not reach CLI');
    return ordered;
}

module.exports = {
    OWNER,
    SHA,
    REPO,
    SECTIONS,
    digest,
    read,
    write,
    validatePlan,
    github,
    pages,
    fileAt,
    buildOrder,
    planId,
};
