const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const SHA = 'a'.repeat(40);
const hash = (value) => createHash('sha1').update(value).digest('hex');
const node = (repo, dependencies = {}, devDependencies = {}) => ({
    repo,
    sha: hash(repo),
    manifest: {name: `@diplodoc/${repo}`, version: '1.0.0', dependencies, devDependencies},
});
const candidate = (repo, number, day = number) => ({
    repo,
    number,
    createdAt: `2026-10-${String(day).padStart(2, '0')}T00:00:00.000Z`,
});

function apiFixture() {
    const graph = ['alpha', 'beta', 'gamma', 'delta', 'unrelated'].map((repo) => node(repo));
    graph.push(
        node('cli', Object.fromEntries(graph.slice(0, 4).map((item) => [item.manifest.name, '*']))),
    );
    const files = new Map();
    const trees = new Map();
    const pulls = new Map();
    const requests = [];
    const checkCalls = [];
    const prefix = '/repos/diplodoc-platform/';

    function addFiles(repo, sha, contents) {
        const tree = Object.entries(contents).map(([filename, value]) => {
            const bytes = typeof value === 'string' ? value : JSON.stringify(value);
            const blob = hash(`${repo}:${sha}:${filename}`);
            files.set(`${repo}:${blob}`, {
                encoding: 'base64',
                size: bytes.length,
                content: Buffer.from(bytes).toString('base64'),
            });
            return {path: filename, type: 'blob', sha: blob};
        });
        trees.set(`${repo}:${sha}`, {truncated: false, tree});
    }

    for (const item of graph) {
        addFiles(item.repo, item.sha, {'package.json': item.manifest});
        pulls.set(item.repo, []);
    }

    addFiles('diplodoc', SHA, {
        '.gitmodules': graph
            .map(
                (item) =>
                    `[submodule "${item.repo}"]\n path = packages/${item.repo}\n url = git@github.com:diplodoc-platform/${item.repo}.git\n`,
            )
            .join(''),
    });

    function addPull(repo, number, options = {}) {
        const base = graph.find((item) => item.repo === repo);
        const dependency = options.dependency || '@types/example';
        const before = {...base.manifest, devDependencies: {[dependency]: '^1.0.0'}};
        const after = options.prepared
            ? before
            : {...before, devDependencies: {[dependency]: '^1.1.0'}};
        const targetVersion = options.targetVersion || '1.1.0';
        const lock = (manifest, version) => ({
            lockfileVersion: 3,
            packages: {
                '': manifest,
                [`node_modules/${dependency}`]: {
                    version,
                    dev: true,
                    ...(options.prepared
                        ? {
                              resolved: `https://registry.npmjs.org/${dependency}/-/${dependency.split('/').at(-1)}-${version}.tgz`,
                              integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
                          }
                        : {}),
                },
            },
        });
        const sha = hash(`${repo}#${number}`);
        addFiles(repo, base.sha, {
            'package.json': before,
            'package-lock.json': lock(before, '1.0.0'),
        });
        if (options.stale)
            addFiles(repo, SHA, {
                'package.json': before,
                'package-lock.json': lock(before, '1.0.0'),
            });
        addFiles(repo, sha, {
            'package.json': after,
            'package-lock.json': lock(after, targetVersion),
        });
        const pr = {
            number,
            state: 'open',
            draft: false,
            created_at: candidate(repo, number, options.day || number).createdAt,
            user: {login: options.prepared ? 'diplodoc-bot' : 'dependabot[bot]'},
            base: {ref: 'master', repo: {name: repo}, sha: options.stale ? SHA : base.sha},
            head: {
                sha,
                ref: options.prepared || `dependabot/npm_and_yarn/${dependency}-1.1.0`,
                repo: {full_name: `diplodoc-platform/${repo}`},
            },
            rebaseable: options.rebaseable ?? true,
            commits: options.commits ?? 1,
        };
        pulls.get(repo).push(pr);
        return pr;
    }

    const request = async (route) => {
        requests.push(route);
        assert.ok(route.startsWith(prefix), 'No unexpected host');
        const url = new URL(route, 'https://api.github.com');
        const [, , , repo, ...parts] = url.pathname.split('/');

        if (parts.join('/') === 'branches/master') {
            return {
                commit: {
                    sha: repo === 'diplodoc' ? SHA : graph.find((item) => item.repo === repo).sha,
                },
            };
        }
        if (
            repo === 'diplodoc' &&
            parts.join('/') === `git/trees/${SHA}` &&
            url.searchParams.get('recursive')
        ) {
            return {
                truncated: false,
                tree: graph.map((item) => ({
                    path: `packages/${item.repo}`,
                    type: 'commit',
                    sha: item.sha,
                })),
            };
        }
        if (parts[0] === 'git' && parts[1] === 'trees')
            return structuredClone(trees.get(`${repo}:${parts[2]}`));
        if (parts[0] === 'git' && parts[1] === 'blobs')
            return structuredClone(files.get(`${repo}:${parts[2]}`));
        if (parts.length === 2 && parts[0] === 'pulls')
            return structuredClone(
                pulls.get(repo).find((item) => item.number === Number(parts[1])),
            );
        if (parts[0] === 'compare') return {merge_base_commit: {sha: parts[1].split('...')[0]}};
        if (parts[0] === 'pulls' && parts[2] === 'files')
            return [{filename: 'package-lock.json', status: 'modified'}];
        if (parts.length === 1 && parts[0] === 'pulls') {
            const offset = (Number(url.searchParams.get('page')) - 1) * 100;
            const head = url.searchParams.get('head');
            const matches = head
                ? pulls
                      .get(repo)
                      .filter(
                          (pr) => head === `${pr.head.repo.full_name.split('/')[0]}:${pr.head.ref}`,
                      )
                : pulls.get(repo).filter((pr) => pr.state === 'open');
            return structuredClone(matches.slice(offset, offset + 100));
        }

        assert.fail(`Unexpected request ${route}`);
    };
    const evidence = {
        fetchCheckRuns: async (_token, _owner, repo, sha) => {
            checkCalls.push(`${repo}:${sha}`);
            return {
                check_runs: [
                    {
                        id: 1,
                        name: 'Quality',
                        app: {id: 15368},
                        head_sha: sha,
                        status: 'completed',
                        conclusion: 'success',
                    },
                ],
            };
        },
        fetchRequiredChecks: async () => [{context: 'Quality', appId: 15368}],
    };

    return {graph, addPull, addFiles, request, evidence, requests, checkCalls};
}

module.exports = {apiFixture};
