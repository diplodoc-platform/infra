const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {runInNewContext} = require('node:vm');
const yaml = require('js-yaml');
const {automaticGroups} = require('../../scripts/candidate-train/automatic-groups');
const {
    reconciliationBranch,
    reconciliationSeed,
    reconcileLock,
} = require('../../scripts/candidate-train/reconcile-lock');
const {
    openReconciliation,
    publishReconciliation,
} = require('../../scripts/candidate-train/reconcile');
const {reviewTarget} = require('../../scripts/candidate-train/approve');
const {readReconciledInput} = require('../../scripts/candidate-train/reconcile-source');

const tests = [];
const test = (name, fn) => tests.push({name, fn});
const sha = 'a'.repeat(40);

function entry(name, version, fields = {}) {
    return {
        version,
        resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
        integrity: `sha512-${Buffer.alloc(64, Number(version.at(-1))).toString('base64')}`,
        ...fields,
    };
}

function fixture() {
    const host = {
        dependencies: {shared: '1.2.0'},
        overrides: {parent: {'.': '1.0.0', aux: '2.2.0'}},
    };
    const cli = {
        lockfileVersion: 3,
        packages: {
            '': host,
            'node_modules/shared': entry('shared', '1.2.0'),
            'node_modules/parent': entry('parent', '1.0.0', {dependencies: {aux: '^2.0.0'}}),
            'node_modules/aux': entry('aux', '2.2.0'),
        },
    };
    const before = {
        lockfileVersion: 3,
        packages: {
            '': {dependencies: {primary: '^1', shared: '^1', parent: '^1', independent: '^1'}},
            'node_modules/primary': entry('primary', '1.0.0'),
            'node_modules/shared': entry('shared', '1.1.0'),
            'node_modules/parent': entry('parent', '1.0.0', {
                dependencies: {aux: '^2.0.0', shared: '^1.1'},
            }),
            'node_modules/aux': entry('aux', '2.1.0'),
            'node_modules/independent': entry('independent', '1.0.0', {
                dependencies: {aux: '^1.0.0'},
            }),
            'node_modules/independent/node_modules/aux': entry('aux', '1.0.0'),
        },
    };
    const head = structuredClone(before);
    head.packages['node_modules/primary'] = entry('primary', '1.1.0');
    return {host, cli, before, head};
}

const align = ({before, head, cli, host}) => reconcileLock(before, head, cli, host, 'primary');

test('reconciles a direct pin and a scoped transitive pin, preserving other installations', () => {
    const data = fixture();
    const {lock, changes} = align(data);
    assert.deepEqual(
        changes.map(({name, to}) => [name, to]),
        [
            ['shared', '1.2.0'],
            ['aux', '2.2.0'],
        ],
    );
    assert.deepEqual(
        changes[0].edges.map(({parent}) => parent),
        ['', 'node_modules/parent'],
    );
    assert.deepEqual(
        changes[1].edges.map(({parent}) => parent),
        ['node_modules/parent'],
    );
    assert.equal(lock.packages['node_modules/independent/node_modules/aux'].version, '1.0.0');
    assert.equal(lock.packages['node_modules/primary'].version, '1.1.0');
    const original = structuredClone(lock);
    for (const {key} of changes) original.packages[key] = data.head.packages[key];
    assert.deepEqual(original, data.head);
});

test('refuses incompatible transitive ranges, changed packages, and noncanonical providers', () => {
    const data = fixture();
    data.head.packages['node_modules/parent'].dependencies.shared = '~1.1.0';
    assert.throws(() => align(data), /parent > shared.*excludes 1.2.0/);
    data.head.packages['node_modules/parent'].dependencies.shared = '^1.1';
    data.head.packages['node_modules/shared'] = entry('shared', '1.1.1');
    assert.throws(() => align(data), /already changed by the original PR/);
    data.head.packages['node_modules/shared'] = data.before.packages['node_modules/shared'];
    data.cli.packages['node_modules/shared'].engines = {node: '>=30'};
    assert.throws(() => align(data), /provider changes package metadata/);
    data.cli.packages['node_modules/shared'].resolved = 'https://example.com/shared';
    assert.deepEqual(
        align(data).changes.map(({name}) => name),
        ['aux'],
    );
});

test('blocks a sixth additional package instead of truncating the group', () => {
    const data = fixture();
    for (const name of ['aa', 'bb', 'cc', 'dd']) {
        data.host.dependencies[name] = '1.1.0';
        data.before.packages[`node_modules/${name}`] = entry(name, '1.0.0');
        data.head.packages[`node_modules/${name}`] = entry(name, '1.0.0');
        data.head.packages[''].dependencies[name] = '^1.0.0';
        data.cli.packages[`node_modules/${name}`] = entry(name, '1.1.0');
    }
    assert.throws(() => align(data), /More than five/);
});

test('automatic selection prefers a validated replacement while retaining the original during CI', () => {
    const seed = {repo: 'alpha', number: 10, risk: 'low', createdAt: '2026-11-22'};
    const replacement = {...seed, number: 11, reconciles: 10};
    const input = {name: 'primary', version: '1.1.0'};
    const inputs = new Map([
        ['alpha#10', input],
        ['alpha#11', input],
    ]);
    const graph = [{repo: 'alpha', manifest: {dependencies: {primary: '^1'}}}];
    const choose = (sources) =>
        automaticGroups(graph, sources, inputs, ['alpha']).groups[0].requests[0].number;
    assert.equal(choose([seed]), 10);
    assert.equal(choose([seed, replacement]), 11);
    const pr = {
        number: 11,
        user: {login: 'diplodoc-bot'},
        head: {ref: reconciliationBranch(10, sha)},
    };
    assert.deepEqual(reconciliationSeed(pr), {number: 10, sha});
    assert.equal(reconciliationSeed({...pr, user: {login: 'someone'}}), null);
});

test('revalidates a replacement against the original PR identity and exact lock delta', async () => {
    const {host, cli, before, head} = fixture();
    const {lock} = reconcileLock(before, head, cli, host, 'primary');
    const repo = {name: 'components', full_name: 'diplodoc-platform/components'};
    const base = {sha, ref: 'master', repo};
    const originalHead = 'b'.repeat(40);
    const replacement = {
        number: 11,
        base,
        user: {login: 'diplodoc-bot'},
        head: {ref: reconciliationBranch(10, originalHead), repo},
    };
    const original = {
        number: 10,
        state: 'open',
        draft: false,
        base,
        user: {login: 'dependabot[bot]'},
        head: {sha: originalHead, repo},
    };
    const request = async (route) => {
        if (route.includes('/git/trees/'))
            return {
                truncated: false,
                tree: [
                    {
                        path: '.github/workflows',
                        type: 'tree',
                        sha: '497eb367ebeaa37bc1c4f970b1e6eca06cfde150',
                    },
                ],
            };
        if (route.includes('/files')) return [{filename: 'package-lock.json', status: 'modified'}];
        assert.ok(route.endsWith('/pulls/10'));
        return original;
    };
    const readSource = async (_repo, exactHead, file) => {
        assert.equal(exactHead, originalHead);
        return JSON.stringify(file === 'package.json' ? head.packages[''] : head);
    };
    const verify = (updated = lock) =>
        readReconciledInput(
            replacement,
            before.packages[''],
            head.packages[''],
            before,
            updated,
            {manifest: host},
            cli,
            readSource,
            request,
        );
    assert.deepEqual(await verify(), {
        input: {name: 'primary', version: '1.1.0'},
        seed: 10,
        additional: ['shared', 'aux'],
    });

    await assert.rejects(verify(head), /differs from canonical inputs/);
    original.head.sha = 'c'.repeat(40);
    await assert.rejects(verify(), /Original Dependabot PR changed/);
});

test('App reconciliation uses the App to open an immutable PR in Algolia', async () => {
    const repo = {name: 'algolia-extension', full_name: 'diplodoc-platform/algolia-extension'};
    const item = {repo: repo.name, number: 10, sha, baseSha: 'b'.repeat(40), lock: {}, changes: []};
    const branch = reconciliationBranch(item.number, item.sha);
    const head = 'c'.repeat(40);
    const seed = {state: 'open', head: {sha}, base: {sha: item.baseSha}};
    const reads = async (route) => {
        if (route.endsWith('/pulls/10')) return seed;
        if (route.endsWith('/branches/master')) return {commit: {sha: item.baseSha}};
        if (route.endsWith('/git/commits/' + item.baseSha)) return {tree: {sha: 'd'.repeat(40)}};
        assert.fail(route);
    };
    const writes = [];
    const app = async (route, {method, body}) => {
        assert.equal(method, 'POST');
        writes.push(route);
        if (route.endsWith('/git/trees')) return {sha: 'e'.repeat(40)};
        if (route.endsWith('/git/commits')) {
            assert.deepEqual(body.parents, [item.baseSha]);
            assert.equal(body.author, undefined);
            return {sha: head};
        }
        if (route.endsWith('/git/refs')) {
            assert.deepEqual(body, {ref: 'refs/heads/' + branch, sha: head});
            return {};
        }
        assert.ok(route.endsWith('/pulls'));
        assert.equal(body.head, branch);
        return {
            number: 11,
            user: {login: 'diplodoc-app[bot]', id: 238451397},
            head: {sha: head, ref: branch, repo},
            base: {sha: item.baseSha, ref: 'master', repo},
        };
    };
    const url = await openReconciliation(
        item,
        {name: 'primary', version: '1.1.0'},
        undefined,
        reads,
        app,
        app,
    );
    assert.equal(url, 'https://github.com/diplodoc-platform/algolia-extension/pull/11');
    assert.equal(writes.length, 4);
});

test('approval re-derives an Algolia App PR and rejects altered locks and other App identities', async () => {
    const {host, cli, before, head} = fixture();
    const {lock} = reconcileLock(before, head, cli, host, 'primary');
    const repo = {name: 'algolia-extension', full_name: 'diplodoc-platform/algolia-extension'};
    const base = {sha, ref: 'master', repo};
    const originalHead = 'b'.repeat(40);
    const revisedHead = 'c'.repeat(40);
    const cliHead = 'd'.repeat(40);
    const item = {repo: repo.name, number: 11, sha: revisedHead, baseSha: sha, profile: 'standard'};
    const plan = {
        cli: {sha: cliHead, manifest: host},
        cohort: {dependency: {name: 'primary', version: '1.1.0'}},
    };
    const original = {
        number: 10,
        state: 'open',
        draft: false,
        base,
        user: {login: 'dependabot[bot]'},
        head: {sha: originalHead, repo},
    };
    const replacement = {
        number: 11,
        state: 'open',
        draft: false,
        base,
        user: {login: 'diplodoc-app[bot]', id: 238451397},
        head: {sha: revisedHead, ref: reconciliationBranch(10, originalHead), repo},
    };
    const locks = new Map([
        [sha, before],
        [originalHead, head],
        [revisedHead, lock],
        [cliHead, cli],
    ]);
    const request = async (route) => {
        if (route.endsWith('/pulls/10')) return original;
        if (route.endsWith('/pulls/11')) return replacement;
        if (route.endsWith('/branches/master')) return {commit: {sha}};
        if (route.includes('/files?')) return [{filename: 'package-lock.json', status: 'modified'}];
        if (route.includes('/reviews?')) return [];
        if (route === '/graphql')
            return {
                data: {
                    repository: {
                        pullRequest: {
                            headRefOid: revisedHead,
                            baseRefOid: sha,
                            reviewDecision: 'REVIEW_REQUIRED',
                        },
                    },
                },
            };
        const rev = route.split('/').at(-1).split('?')[0];
        if (route.includes('/git/trees/') && route.includes('?recursive=1')) {
            return {
                truncated: false,
                tree: [
                    {
                        path: '.github/workflows',
                        type: 'tree',
                        sha: 'ace8f091ee94ac000b0186107ee7e6ac7451af1a',
                    },
                ],
            };
        }
        if (route.includes('/git/trees/')) {
            return {
                truncated: false,
                tree: ['package.json', 'package-lock.json'].map((path) => ({
                    path,
                    type: 'blob',
                    sha: rev + ':' + path,
                })),
            };
        }
        if (route.includes('/git/blobs/')) {
            const [commit, file] = rev.split(':');
            const tree = locks.get(commit);
            const data = Buffer.from(
                JSON.stringify(file === 'package.json' ? tree.packages[''] : tree),
            );
            return {encoding: 'base64', content: data.toString('base64'), size: data.length};
        }
        assert.fail(route);
    };
    const evidence = {
        fetchCheckRuns: async () => ({
            check_runs: [
                {
                    id: 1,
                    name: 'Quality',
                    app: {id: 15368},
                    head_sha: revisedHead,
                    status: 'completed',
                    conclusion: 'success',
                },
            ],
        }),
        fetchRequiredChecks: async () => [{context: 'Quality', appId: 15368}],
    };
    const review = () => reviewTarget(item, plan, request, '', evidence);
    assert.equal((await review()).alreadyApproved, false);
    locks.set(revisedHead, head);
    await assert.rejects(review(), /differs from canonical inputs/);
    replacement.user.id = 1;
    await assert.rejects(review(), /trusted App reconciliation/);
    replacement.user.id = 238451397;
    replacement.head.repo = {full_name: 'another/algolia-extension'};
    await assert.rejects(review(), /trusted App reconciliation/);
});

test('prepared lock CI trusts the Algolia App author only for same-repository reconcile branches', () => {
    const workflow = yaml.load(
        fs.readFileSync(
            path.join(__dirname, '../../scaffolding/.github/workflows/package-lock.yml'),
            'utf8',
        ),
    );
    const repo = 'diplodoc-platform/algolia-extension';
    const ref = reconciliationBranch(10, sha);
    const check = workflow.jobs['verify-dependabot-lock'].if;
    const regenerate = workflow.jobs['update-package-lock'].if;
    const selectedResult = workflow.jobs['package-lock-result'].steps[0].env.LOCK_RESULT.slice(
        3,
        -2,
    )
        .replace('needs.verify-dependabot-lock', 'needs.verify')
        .replace('needs.update-package-lock', 'needs.update');
    const scenarios = [
        [repo, repo, ref, 238451397, true],
        [repo, 'someone/algolia-extension', ref, 238451397, false],
        [repo, repo, ref, 123, false],
        [repo, repo, 'codex/dependency-group-' + 'a'.repeat(24), 238451397, false],
        ['diplodoc-platform/components', 'diplodoc-platform/components', ref, 238451397, false],
    ];
    for (const [repository, headRepository, branch, id, expected] of scenarios) {
        const context = {
            github: {
                actor: 'human-rerunning-checks',
                repository,
                event: {
                    pull_request: {
                        user: {login: 'diplodoc-app[bot]', id},
                        head: {repo: {full_name: headRepository}, ref: branch},
                    },
                },
            },
            startsWith: (value, prefix) => value.startsWith(prefix),
            needs: {verify: {result: 'success'}, update: {result: 'skipped'}},
        };
        assert.equal(runInNewContext(check, context), expected);
        assert.equal(runInNewContext(regenerate, context), false);
        assert.equal(runInNewContext(selectedResult, context), expected ? 'success' : 'skipped');
    }
});

test('reconciliation uses the existing schedule only when independently enabled', () => {
    const workflow = yaml.load(
        fs.readFileSync(
            path.join(__dirname, '../../.github/workflows/dependency-refresh.yml'),
            'utf8',
        ),
    );
    assert.equal(workflow.on.workflow_dispatch.inputs.reconcile.default, false);
    assert.equal(workflow.on.workflow_dispatch.inputs.dry_run.default, true);
    const plan = workflow.jobs.reconcile;
    for (const value of ['', 'false', 'true']) {
        assert.equal(
            runInNewContext(plan.if, {
                github: {event_name: 'schedule'},
                inputs: {},
                vars: {DEPENDENCY_TRAIN_RECONCILE_ENABLED: value},
                needs: {refresh: {result: 'success'}},
                cancelled: () => false,
            }),
            value === 'true',
        );
    }
    assert.ok(!JSON.stringify(plan).includes('secrets.'));
});

test('manual reconciliation can publish after skipping the ordinary refresh', () => {
    const workflow = yaml.load(
        fs.readFileSync(
            path.join(__dirname, '../../.github/workflows/dependency-refresh.yml'),
            'utf8',
        ),
    );
    const publish = workflow.jobs['publish-reconciliation'];
    // An explicit status function replaces GitHub Actions' implicit success() check,
    // which would skip this job because an ancestor was skipped.
    assert.match(publish.if, /^!cancelled\(\) &&/);

    const canPublish = ({
        dryRun = false,
        result = 'success',
        repositories = 'algolia-extension',
        ref = 'refs/heads/master',
        cancelled = false,
    } = {}) =>
        runInNewContext(publish.if, {
            github: {event_name: 'workflow_dispatch', ref},
            needs: {reconcile: {result, outputs: {repositories}}},
            inputs: {dry_run: dryRun},
            cancelled: () => cancelled,
        });

    assert.equal(canPublish(), true);
    assert.equal(canPublish({dryRun: true}), false);
    assert.equal(canPublish({result: 'failure'}), false);
    assert.equal(canPublish({result: 'skipped'}), false);
    assert.equal(canPublish({repositories: ''}), false);
    assert.equal(canPublish({ref: 'refs/heads/feature'}), false);
    assert.equal(canPublish({cancelled: true}), false);
});

test('reconciliation never requests write credentials without explicit opt-in and master', async () => {
    const noNetwork = () => assert.fail('Authorization must precede all network calls');
    const env = {GITHUB_REPOSITORY: 'diplodoc-platform/infra', GITHUB_REF: 'refs/heads/master'};
    await assert.rejects(publishReconciliation({}, env, noNetwork), /expected|Expected/);
    await assert.rejects(
        publishReconciliation(
            {},
            {
                ...env,
                GITHUB_REF: 'refs/heads/feature',
                DEPENDENCY_TRAIN_RECONCILE_APPROVED: 'true',
            },
            noNetwork,
        ),
        /refs\/heads\/master/,
    );
});

module.exports = {tests};
