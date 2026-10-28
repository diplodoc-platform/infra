const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {digest, planId, write} = require('../../scripts/candidate-train/common');
const {withArchives} = require('../../scripts/candidate-train/build');
const {publish} = require('../../scripts/candidate-train/publish');

const tests = [];
const test = (name, fn) => tests.push({name, fn});
const SHA = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const BASE_TREE = 'c'.repeat(40);
const CANDIDATE_TREE = 'd'.repeat(40);
const prefix = '/repos/diplodoc-platform/cli';
const blobSha = (bytes) =>
    createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

function fixture(options = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-publication-'));
    const source = {repo: 'utils', sha: SHA, manifest: {name: '@diplodoc/utils', version: '1.0.0'}};
    const cli = {
        repo: 'cli',
        sha: SHA,
        manifest: {
            name: '@diplodoc/cli',
            version: '1.0.0',
            dependencies: {'@diplodoc/utils': '^1.0.0'},
        },
    };
    if (options.unplannedDrift) cli.manifest.dependencies.parser = '^1.0.0';
    const plan = {
        schema: 1,
        toolSha: SHA,
        metapackageSha: SHA,
        readyBy: '2026-10-23T05:00:00.000Z',
        graph: [source, cli],
        cli,
        selected: [{...source, number: 3, baseSha: SHA}],
    };
    plan.id = planId(plan);
    const branch = `codex/dependency-candidate-${plan.id}`;
    const lock = {lockfileVersion: 3, packages: {'': source.manifest}};
    const registry = (name, version) => ({
        version,
        resolved: `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`,
        integrity: `sha512-${createHash('sha512').update(`${name}@${version}`).digest('base64')}`,
    });
    const baselineLock = {
        lockfileVersion: 3,
        packages: {
            '': cli.manifest,
            'node_modules/@diplodoc/utils': registry('@diplodoc/utils', '1.0.0'),
        },
    };
    const manifest = withArchives(cli.manifest, new Map([['@diplodoc/utils', {...source, lock}]]));
    manifest.files = ['dependency-train'];
    write(path.join(directory, 'package.json'), manifest);
    const archive = Buffer.from('packed utils');
    const candidateLock = {
        lockfileVersion: 3,
        packages: {
            '': manifest,
            'node_modules/@diplodoc/utils': {
                version: '1.0.0',
                resolved: 'file:dependency-train/payload/utils.tgz',
                integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}`,
            },
        },
    };
    if (options.unplannedDrift) {
        baselineLock.packages['node_modules/parser'] = registry('parser', '1.1.0');
        candidateLock.packages['node_modules/parser'] = registry('parser', '1.0.0');
    }
    write(path.join(directory, 'package-lock.json'), candidateLock);
    fs.mkdirSync(path.join(directory, 'dependency-train/payload'), {recursive: true});
    fs.writeFileSync(path.join(directory, 'dependency-train/payload/utils.tgz'), archive);
    write(path.join(directory, 'dependency-train/proof.json'), {
        schema: 1,
        trainId: plan.id,
        toolSha: SHA,
        cliBaseSha: SHA,
        packages: [
            {
                repo: 'utils',
                name: '@diplodoc/utils',
                sourceSha: SHA,
                sourceLockSha256: digest(JSON.stringify(lock)),
                archiveSha256: digest(archive),
                resolutions: [],
            },
        ],
    });
    const files = [
        'package.json',
        'package-lock.json',
        'dependency-train/proof.json',
        'dependency-train/payload/utils.tgz',
    ];
    const entries = files.map((file) => ({
        path: file,
        mode: '100644',
        type: 'blob',
        sha: blobSha(fs.readFileSync(path.join(directory, file))),
    }));
    entries.push({
        path: 'dependency-train/plan.json',
        mode: '100644',
        type: 'blob',
        sha: blobSha(Buffer.from(JSON.stringify(plan, null, 2) + '\n')),
    });
    const baseline = [
        {path: 'src', mode: '040000', type: 'tree', sha: SHA},
        {path: 'bin', mode: '040000', type: 'tree', sha: SHA},
        {path: 'package.json', mode: '100644', type: 'blob', sha: SHA},
        {path: 'src/index.ts', mode: '100644', type: 'blob', sha: SHA},
        {path: 'bin/cli', mode: '100755', type: 'blob', sha: SHA},
    ];
    const remote = {
        pr: {
            number: 12,
            state: 'open',
            user: {login: 'diplodoc-bot'},
            head: {sha: HEAD, ref: branch, repo: {full_name: 'diplodoc-platform/cli'}},
            base: {ref: 'master', repo: {full_name: 'diplodoc-platform/cli'}},
            html_url: 'https://github.com/diplodoc-platform/cli/pull/12',
        },
        commit: {sha: HEAD, tree: {sha: CANDIDATE_TREE}, parents: [{sha: SHA}]},
        tree: structuredClone([
            ...baseline.filter((item) => item.path !== 'package.json'),
            {path: 'dependency-train', mode: '040000', type: 'tree', sha: SHA},
            {path: 'dependency-train/payload', mode: '040000', type: 'tree', sha: SHA},
            ...entries,
        ]),
        sourceReads: 0,
        writes: [],
    };
    const env = {
        GITHUB_SHA: SHA,
        DEPENDENCY_CANDIDATE_PREPARE_APPROVED: 'true',
        TRAIN_APP_TOKEN: 'mock-app',
        TRAIN_BOT_TOKEN: 'mock-bot',
        TRAIN_RUN_URL: 'https://github.com/diplodoc-platform/infra/actions/runs/1',
    };
    const request = async (route, {method = 'GET', body, token} = {}) => {
        if (method !== 'GET') remote.writes.push({route, method, body, token});
        if (route === '/user') {
            assert.equal(token, env.TRAIN_BOT_TOKEN);
            return {login: 'diplodoc-bot'};
        }
        if (route === '/repos/diplodoc-platform/utils/pulls/3') {
            remote.sourceReads++;
            return {
                state: 'open',
                user: {login: 'dependabot[bot]'},
                head: {
                    repo: {full_name: 'diplodoc-platform/utils'},
                    sha: remote.sourceReads === options.changedSourceAt ? HEAD : SHA,
                },
                base: {sha: SHA},
            };
        }
        if (route === `/repos/diplodoc-platform/utils/git/trees/${SHA}`) {
            return {truncated: false, tree: [{path: 'package-lock.json', type: 'blob', sha: SHA}]};
        }
        if (route === `/repos/diplodoc-platform/utils/git/blobs/${SHA}`) {
            const content = Buffer.from(JSON.stringify(lock));
            return {encoding: 'base64', content: content.toString('base64'), size: content.length};
        }
        if (route === `${prefix}/git/trees/${SHA}`) {
            return {truncated: false, tree: [{path: 'package-lock.json', type: 'blob', sha: SHA}]};
        }
        if (route === `${prefix}/git/blobs/${SHA}`) {
            const content = Buffer.from(JSON.stringify(baselineLock));

            return {encoding: 'base64', content: content.toString('base64'), size: content.length};
        }
        if (route.startsWith(`${prefix}/pulls?state=all&head=`)) {
            return options.reuse ? [structuredClone(remote.pr)] : [];
        }
        if (route.startsWith(`${prefix}/pulls?state=open&base=master`)) return [];
        if (route === `${prefix}/git/commits/${SHA}`) return {tree: {sha: BASE_TREE}};
        if (route === `${prefix}/git/commits/${HEAD}`) return structuredClone(remote.commit);
        if (route === `${prefix}/git/trees/${BASE_TREE}?recursive=1`) {
            return {truncated: false, tree: structuredClone(baseline)};
        }
        if (route === `${prefix}/git/trees/${CANDIDATE_TREE}?recursive=1`) {
            return {truncated: false, tree: structuredClone(remote.tree)};
        }
        if (route === `${prefix}/git/blobs` && method === 'POST') {
            assert.equal(token, env.TRAIN_APP_TOKEN);
            return {sha: blobSha(Buffer.from(body.content, body.encoding))};
        }
        if (route === `${prefix}/git/trees` && method === 'POST') {
            assert.equal(token, env.TRAIN_APP_TOKEN);
            assert.equal(body.base_tree, BASE_TREE);
            assert.deepEqual(
                body.tree,
                [...entries].sort((a, b) => {
                    // validatePayload sorts artifact paths; the trusted plan is appended separately.
                    if (a.path.endsWith('/plan.json')) return 1;
                    if (b.path.endsWith('/plan.json')) return -1;
                    return a.path.localeCompare(b.path);
                }),
            );
            return {sha: CANDIDATE_TREE};
        }
        if (route === `${prefix}/git/commits` && method === 'POST') {
            assert.equal(token, env.TRAIN_APP_TOKEN);
            assert.deepEqual(body.parents, [SHA]);
            return {sha: HEAD};
        }
        if (route === `${prefix}/git/refs` && method === 'POST') {
            assert.equal(token, env.TRAIN_APP_TOKEN);
            assert.deepEqual(body, {ref: `refs/heads/${branch}`, sha: HEAD});
            if (options.resume) throw Object.assign(new Error('already exists'), {status: 422});
            return {};
        }
        if (route === `${prefix}/git/ref/heads/${branch}`) {
            return {object: {sha: HEAD, type: 'commit'}};
        }
        if (route === `${prefix}/pulls` && method === 'POST') {
            assert.equal(token, env.TRAIN_BOT_TOKEN);
            assert.equal(body.base, 'master');
            assert.equal(body.head, branch);
            return structuredClone(remote.pr);
        }
        if (route === `${prefix}/pulls/12`) {
            const pr = structuredClone(remote.pr);
            if (options.staleHead) pr.head.sha = 'e'.repeat(40);
            return pr;
        }
        throw new Error(`Unexpected mock API call: ${method} ${route}`);
    };
    return {
        remote,
        run: () => publish(plan, directory, env, request),
        close: () => fs.rmSync(directory, {recursive: true, force: true}),
    };
}

test('publisher independently rejects unrelated lock drift before any remote write', async () => {
    const context = fixture({unplannedDrift: true});

    try {
        await assert.rejects(context.run(), /drift|unplanned|baseline/i);
        assert.equal(context.remote.writes.length, 0);
    } finally {
        context.close();
    }
});

for (const options of [{}, {reuse: true}, {resume: true}]) {
    test(`candidate publication succeeds with exact identity (${JSON.stringify(options)})`, async () => {
        const context = fixture(options);
        try {
            const result = await context.run();
            assert.equal(result.sha, HEAD);
            assert.equal(result.number, 12);
            assert.equal(result.reused, Boolean(options.reuse));
            if (options.reuse) assert.equal(context.remote.writes.length, 0);
        } finally {
            context.close();
        }
    });
}

for (const [name, mutate] of [
    [
        'non-master target',
        (remote) => {
            remote.pr.base.ref = 'release';
        },
    ],
    [
        'foreign base repository',
        (remote) => {
            remote.pr.base.repo.full_name = 'fork/cli';
        },
    ],
    [
        'noncanonical branch',
        (remote) => {
            remote.pr.head.ref = 'another-candidate';
        },
    ],
    [
        'another baseline parent',
        (remote) => {
            remote.commit.parents = [{sha: HEAD}];
        },
    ],
    [
        'multiple parents',
        (remote) => {
            remote.commit.parents.push({sha: HEAD});
        },
    ],
    [
        'source-file changes',
        (remote) => {
            remote.tree.find((item) => item.path === 'src/index.ts').sha = HEAD;
        },
    ],
    [
        'extra files',
        (remote) => {
            remote.tree.push({path: 'extra.js', type: 'blob', mode: '100644', sha: SHA});
        },
    ],
    [
        'extra empty trees',
        (remote) => {
            remote.tree.push({path: 'extra', type: 'tree', mode: '040000', sha: SHA});
        },
    ],
    [
        'directory mode changes',
        (remote) => {
            remote.tree.find((item) => item.path === 'src').mode = '100644';
        },
    ],
    [
        'deleted files',
        (remote) => {
            remote.tree = remote.tree.filter((item) => item.path !== 'src/index.ts');
        },
    ],
    [
        'payload mode changes',
        (remote) => {
            remote.tree.find((item) => item.path === 'package.json').mode = '100755';
        },
    ],
    [
        'baseline mode changes',
        (remote) => {
            remote.tree.find((item) => item.path === 'bin/cli').mode = '100644';
        },
    ],
    [
        'payload changes',
        (remote) => {
            remote.tree.find((item) => item.path === 'package.json').sha = HEAD;
        },
    ],
]) {
    test(`candidate reuse rejects ${name}`, async () => {
        const context = fixture({reuse: true});
        try {
            mutate(context.remote);
            await assert.rejects(context.run());
            assert.equal(context.remote.writes.length, 0);
        } finally {
            context.close();
        }
    });
}

test('candidate 422 resume rejects a matching tree with another parent', async () => {
    const context = fixture({resume: true});
    try {
        context.remote.commit.parents = [{sha: HEAD}];
        await assert.rejects(context.run(), /frozen CLI baseline/);
        assert.ok(!context.remote.writes.some((item) => item.route === `${prefix}/pulls`));
    } finally {
        context.close();
    }
});

for (const options of [{reuse: true}, {}]) {
    test(`candidate publication rejects a head moved before handoff (${JSON.stringify(options)})`, async () => {
        const context = fixture({...options, staleHead: true});
        try {
            await assert.rejects(context.run(), /Candidate head changed/);
        } finally {
            context.close();
        }
    });
}

for (const options of [
    {reuse: true, changedSourceAt: 2},
    {changedSourceAt: 2},
    {changedSourceAt: 3},
]) {
    test(`candidate publication rejects source changes (${JSON.stringify(options)})`, async () => {
        const context = fixture(options);
        try {
            await assert.rejects(context.run(), /Source PR head changed/);
            if (options.changedSourceAt === 2) {
                assert.ok(!context.remote.writes.some((item) => item.route === `${prefix}/pulls`));
            }
        } finally {
            context.close();
        }
    });
}

module.exports = {tests};
