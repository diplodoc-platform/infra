'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {
    OWNER,
    SHA,
    SECTIONS,
    digest,
    read,
    write,
    validatePlan,
    buildOrder,
    github,
    pages,
    fileAt,
} = require('./common');
const {withArchives} = require('./build');

function validatePayload(plan, directory, locks = new Map()) {
    validatePlan(plan);
    const order = buildOrder(plan.graph, plan.selected).filter((item) => item.repo !== 'cli');
    const names = new Map(
        order.map((item) => [item.manifest.name, {...item, lock: locks.get(item.repo)}]),
    );
    const expected = withArchives(plan.cli.manifest, names);
    expected.files = [...new Set([...(plan.cli.manifest.files || []), 'dependency-train'])];
    assert.deepEqual(
        read(path.join(directory, 'package.json')),
        expected,
        'Candidate may change only the planned dependency specs/overrides and package file inclusion',
    );
    const lock = read(path.join(directory, 'package-lock.json'));
    assert.equal(lock.lockfileVersion, 3);
    for (const section of SECTIONS) {
        assert.deepEqual(lock.packages[''][section] || {}, expected[section] || {});
    }
    const proof = read(path.join(directory, 'dependency-train', 'proof.json'));
    assert.equal(proof.schema, 1);
    assert.equal(proof.trainId, plan.id);
    assert.equal(proof.toolSha, plan.toolSha);
    assert.equal(proof.cliBaseSha, plan.cli.sha);
    assert.equal(proof.packages.length, order.length);
    const files = [
        'package.json',
        'package-lock.json',
        'dependency-train/proof.json',
        ...order.map((item) => `dependency-train/payload/${item.repo}.tgz`),
    ];
    const actualFiles = [];
    let total = 0;
    function visit(root, relative = '') {
        for (const entry of fs.readdirSync(root, {withFileTypes: true})) {
            const name = relative + entry.name;
            assert.ok(!entry.isSymbolicLink(), 'Payload symlinks are forbidden');
            if (entry.isDirectory()) visit(path.join(root, entry.name), name + '/');
            else {
                assert.ok(entry.isFile(), 'Only regular payload files are allowed');
                const size = fs.statSync(path.join(root, entry.name)).size;
                assert.ok(size < 40 * 1024 * 1024, 'Payload file exceeds the Git blob limit');
                total += size;
                actualFiles.push(name);
            }
        }
    }
    visit(directory);
    assert.ok(total < 100 * 1024 * 1024, 'Payload exceeds the bounded train size');
    assert.deepEqual(actualFiles.sort(), files.sort(), 'Unexpected payload files');
    for (const node of order) {
        const item = proof.packages.find((entry) => entry.repo === node.repo);
        assert.equal(item?.name, node.manifest.name);
        assert.equal(item.sourceSha, node.sha);
        if (locks.has(node.repo)) {
            assert.equal(item.sourceLockSha256, digest(JSON.stringify(locks.get(node.repo))));
        }
        assert.equal(
            item.archiveSha256,
            digest(
                fs.readFileSync(
                    path.join(directory, 'dependency-train', 'payload', `${node.repo}.tgz`),
                ),
            ),
        );
        assert.ok(Array.isArray(item.resolutions));
    }
    for (const entry of Object.values(lock.packages)) {
        if (!entry.resolved?.startsWith('file:')) continue;
        const node = order.find(
            (item) => entry.resolved === `file:dependency-train/payload/${item.repo}.tgz`,
        );
        assert.ok(node, 'Non-relocatable or unknown file resolution in CLI lock');
        const archive = fs.readFileSync(
            path.join(directory, `dependency-train/payload/${node.repo}.tgz`),
        );
        assert.equal(
            entry.integrity,
            `sha512-${createHash('sha512').update(archive).digest('base64')}`,
            'CLI lock is not bound to the packed archive',
        );
    }
    return files;
}

async function unchangedSources(plan, request = github) {
    for (const item of plan.selected) {
        const pr = await request(`/repos/${OWNER}/${item.repo}/pulls/${item.number}`);
        assert.equal(pr.state, 'open', 'Source PR is no longer open');
        assert.equal(pr.user.login, 'dependabot[bot]');
        assert.equal(pr.head.repo.full_name, `${OWNER}/${item.repo}`);
        assert.equal(pr.head.sha, item.sha, 'Source PR head changed; rebuild the train');
        assert.equal(pr.base.sha, item.baseSha, 'Source PR base changed; rebuild the train');
    }
}

function candidateBody(plan, runUrl) {
    return (
        `## Temporary dependency candidate — DO NOT MERGE OR RELEASE\n\n` +
        `Train: \`${plan.id}\`. CLI baseline: \`${plan.cli.sha}\`.\n\n` +
        plan.selected
            .map((item) => `- ${OWNER}/${item.repo}#${item.number}: \`${item.sha}\``)
            .join('\n') +
        `\n\nLocal archives contain unpublished package builds; scoped overrides carry their locked runtime versions. ` +
        `Affected consumers, including client assets where needed, are rebuilt. ` +
        `Installed-resolution evidence is in \`dependency-train/proof.json\`.\n\n` +
        `Target: ready for the operator by **08:00 Europe/Moscow**. ` +
        `The existing Internal check prepares the downstream PR; its CI still needs manual start. ` +
        `Internal observation and existing notifications belong to the private operations system. ` +
        `Preparation is NOT successful document verification.\n\n` +
        `[Preparation](${runUrl}). Hand off this exact PR/SHA and tooling SHA to the internal observer. ` +
        `Missing, skipped, stale or failed checks are not success. No merge or release is authorized.\n`
    );
}

function assertCandidatePr(pr, branch, expectedSha) {
    assert.ok(Number.isInteger(pr.number) && pr.number > 0, 'Invalid candidate PR');
    assert.equal(pr.state, 'open', 'This immutable train was already closed');
    assert.equal(pr.user?.login, 'diplodoc-bot');
    assert.equal(pr.head?.repo?.full_name, `${OWNER}/cli`);
    assert.equal(pr.head.ref, branch, 'Unexpected candidate branch');
    assert.equal(pr.base?.repo?.full_name, `${OWNER}/cli`);
    assert.equal(pr.base.ref, 'master', 'Candidate must target master');
    assert.match(pr.head.sha, SHA);
    if (expectedSha) {
        assert.equal(pr.head.sha, expectedSha, 'Candidate head changed; rebuild the train');
    }
}

function assertCandidateParent(commit, sha, plan) {
    assert.equal(commit.sha, sha);
    assert.deepEqual(
        commit.parents?.map((parent) => parent.sha),
        [plan.cli.sha],
        'Candidate must have exactly the frozen CLI baseline as its parent',
    );
    assert.match(commit.tree?.sha, SHA);
}

async function verifyExistingCandidate(plan, sha, entries, request) {
    const prefix = `/repos/${OWNER}/cli`;
    const commit = await request(`${prefix}/git/commits/${sha}`);
    assertCandidateParent(commit, sha, plan);

    const base = await request(`${prefix}/git/commits/${plan.cli.sha}`);
    const baseline = await request(`${prefix}/git/trees/${base.tree.sha}?recursive=1`);
    const candidate = await request(`${prefix}/git/trees/${commit.tree.sha}?recursive=1`);
    assert.equal(baseline.truncated, false, 'CLI baseline tree is incomplete');
    assert.equal(candidate.truncated, false, 'Candidate tree is incomplete');

    // Directory hashes change with their children; compare their paths/modes and
    // every non-directory object's full identity instead of ignoring directories.
    const identities = (tree) =>
        tree.map(({path, mode, type, sha}) => ({
            path,
            mode,
            type,
            ...(type === 'tree' ? {} : {sha}),
        }));
    const expected = new Map(identities(baseline.tree).map((entry) => [entry.path, entry]));
    for (const [file, bytes] of entries) {
        const blobSha = createHash('sha1')
            .update(`blob ${bytes.length}\0`)
            .update(bytes)
            .digest('hex');
        expected.set(file, {path: file, mode: '100644', type: 'blob', sha: blobSha});
        const segments = file.split('/');
        for (let index = 1; index < segments.length; index++) {
            const directory = segments.slice(0, index).join('/');
            assert.ok(
                !expected.has(directory) || expected.get(directory).type === 'tree',
                'Payload directory would replace a baseline file',
            );
            expected.set(directory, {path: directory, mode: '040000', type: 'tree'});
        }
    }
    const byPath = (a, b) => a.path.localeCompare(b.path);
    assert.deepEqual(
        identities(candidate.tree).sort(byPath),
        [...expected.values()].sort(byPath),
        'Existing candidate must contain only the exact approved changes on the frozen baseline',
    );
}

async function publish(plan, directory, env = process.env, request = github) {
    validatePlan(plan);
    assert.equal(plan.toolSha, env.GITHUB_SHA, 'Tooling revision changed');
    assert.equal(env.DEPENDENCY_CANDIDATE_PREPARE_APPROVED, 'true', 'Preparation is not approved');
    assert.ok(env.TRAIN_APP_TOKEN && env.TRAIN_BOT_TOKEN, 'Publisher credentials are required');
    const botRequest = (route, options = {}) =>
        request(route, {...options, token: env.TRAIN_BOT_TOKEN});
    const appRequest = (route, options = {}) =>
        request(route, {...options, token: env.TRAIN_APP_TOKEN});
    const bot = await botRequest('/user');
    assert.equal(bot.login, 'diplodoc-bot', 'The PR opener must be the contributor bot');
    await unchangedSources(plan, request);
    const locks = new Map();
    for (const node of buildOrder(plan.graph, plan.selected).filter(
        (item) => item.repo !== 'cli',
    )) {
        locks.set(
            node.repo,
            JSON.parse(await fileAt(node.repo, node.sha, 'package-lock.json', request)),
        );
    }
    const files = validatePayload(plan, directory, locks);
    const prefix = `/repos/${OWNER}/cli`;
    const branch = `codex/dependency-candidate-${plan.id}`;
    const pulls = await pages(
        `${prefix}/pulls?state=all&head=${OWNER}:${encodeURIComponent(branch)}`,
        request,
    );
    if (pulls.length) {
        assert.equal(pulls.length, 1);
        const pr = pulls[0];
        assertCandidatePr(pr, branch);
        const entries = [
            ...files.map((file) => [file, fs.readFileSync(path.join(directory, file))]),
            ['dependency-train/plan.json', Buffer.from(JSON.stringify(plan, null, 2) + '\n')],
        ];
        await verifyExistingCandidate(plan, pr.head.sha, entries, request);
        await unchangedSources(plan, request);
        assertCandidatePr(await request(`${prefix}/pulls/${pr.number}`), branch, pr.head.sha);
        return {
            number: pr.number,
            sha: pr.head.sha,
            branch,
            reused: true,
            payloadSha256: digest(
                fs.readFileSync(path.join(directory, 'dependency-train/proof.json')),
            ),
            url: pr.html_url,
            plan,
        };
    }
    const active = await pages(`${prefix}/pulls?state=open&base=master`, request);
    assert.ok(
        !active.some((pr) => pr.head.ref.startsWith('codex/dependency-candidate-')),
        'An earlier candidate is still open; resolve it before starting another train',
    );
    const base = await request(`${prefix}/git/commits/${plan.cli.sha}`);
    const tree = [];
    for (const file of files) {
        const blob = await appRequest(`${prefix}/git/blobs`, {
            method: 'POST',
            body: {
                encoding: 'base64',
                content: fs.readFileSync(path.join(directory, file)).toString('base64'),
            },
        });
        tree.push({path: file, mode: '100644', type: 'blob', sha: blob.sha});
    }
    // The trusted selection plan is not taken from the untrusted build artifact.
    const planBlob = await appRequest(`${prefix}/git/blobs`, {
        method: 'POST',
        body: {
            encoding: 'base64',
            content: Buffer.from(JSON.stringify(plan, null, 2) + '\n').toString('base64'),
        },
    });
    tree.push({
        path: 'dependency-train/plan.json',
        mode: '100644',
        type: 'blob',
        sha: planBlob.sha,
    });
    const createdTree = await appRequest(`${prefix}/git/trees`, {
        method: 'POST',
        body: {base_tree: base.tree.sha, tree},
    });
    const commit = await appRequest(`${prefix}/git/commits`, {
        method: 'POST',
        body: {
            message: `chore(deps): temporary candidate ${plan.id} (do not merge)`,
            tree: createdTree.sha,
            parents: [plan.cli.sha],
        },
    });
    // A unique, immutable branch: never update or force-push an existing head.
    try {
        await appRequest(`${prefix}/git/refs`, {
            method: 'POST',
            body: {ref: `refs/heads/${branch}`, sha: commit.sha},
        });
    } catch (error) {
        if (error.status !== 422) throw error;
        const ref = await request(`${prefix}/git/ref/heads/${branch}`);
        assert.equal(ref.object.type, 'commit');
        const current = await request(`${prefix}/git/commits/${ref.object.sha}`);
        assertCandidateParent(current, ref.object.sha, plan);
        assert.equal(current.tree.sha, createdTree.sha, 'Existing branch has another payload');
        commit.sha = ref.object.sha;
    }
    await unchangedSources(plan, request);
    const pr = await botRequest(`${prefix}/pulls`, {
        method: 'POST',
        body: {
            head: branch,
            base: 'master',
            draft: false,
            title: `chore(deps): temporary candidate train ${plan.id} — DO NOT MERGE`,
            body: candidateBody(plan, env.TRAIN_RUN_URL),
        },
    });
    assertCandidatePr(pr, branch, commit.sha);
    await unchangedSources(plan, request);
    assertCandidatePr(await request(`${prefix}/pulls/${pr.number}`), branch, commit.sha);
    return {
        number: pr.number,
        sha: commit.sha,
        branch,
        url: pr.html_url,
        reused: false,
        plan,
        payloadSha256: digest(fs.readFileSync(path.join(directory, 'dependency-train/proof.json'))),
    };
}

if (require.main === module) {
    publish(read(process.argv[2]), path.resolve(process.argv[3]))
        .then((result) => {
            write('train-candidate.json', result);
            fs.appendFileSync(
                process.env.GITHUB_OUTPUT,
                `number=${result.number}\nsha=${result.sha}\n`,
            );
            fs.appendFileSync(
                process.env.GITHUB_STEP_SUMMARY,
                `## Candidate prepared — NOT verified\n\n` +
                    `[CLI PR](${result.url})\n\n` +
                    `PR number: ${result.number}\n\nCLI SHA: \`${result.sha}\`\n\n` +
                    `Tooling SHA: \`${result.plan.toolSha}\`\n\n` +
                    `Hand these identities to the internal operations observer. ` +
                    `No merge, release or distribution was performed.\n`,
            );
        })
        .catch((error) => {
            console.error(error.message);
            process.exitCode = 1;
        });
}

module.exports = {validatePayload, unchangedSources, candidateBody, publish};
