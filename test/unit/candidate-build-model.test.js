const assert = require('node:assert/strict');
const {buildOrder} = require('../../scripts/candidate-train/common');
const {repositoryTargets} = require('../../scripts/candidate-train/waves');
const {
    CLI_BUNDLED_INPUTS,
    OPT_IN_EXTENSIONS,
    optInExtension,
    buildEdges,
} = require('../../scripts/candidate-train/model');

const tests = [];
const test = (name, fn) => tests.push({name, fn});
const dependencies = (...names) =>
    Object.fromEntries(names.map((name) => [`@diplodoc/${name}`, '^1.0.0']));
const node = (repo, runtime = [], development = [], name = `@diplodoc/${repo}`) => ({
    repo,
    sha: 'a'.repeat(40),
    manifest: {
        name,
        version: '1.0.0',
        dependencies: dependencies(...runtime),
        devDependencies: dependencies(...development),
    },
});

/**
 * Registered package topology, including CLI bundles and independent opt-ins.
 *
 * @returns {object[]} Frozen source graph fixture.
 */
function platformGraph() {
    return [
        node('ajv'),
        node(
            'cli',
            ['ajv', 'client', 'color-extension', 'liquid', 'transform', 'translation', 'utils'],
            [...CLI_BUNDLED_INPUTS.map((name) => name.slice('@diplodoc/'.length)), 'infra'],
        ),
        node(
            'client',
            [],
            [
                'components',
                'latex-extension',
                'mermaid-extension',
                'openapi-extension',
                'page-constructor-extension',
                'tabs-extension',
                'transform',
            ],
        ),
        node('components'),
        node('directive'),
        node('liquid'),
        node('sentenizer'),
        node('transform', [
            'cut-extension',
            'directive',
            'file-extension',
            'tabs-extension',
            'utils',
        ]),
        node('translation', ['ajv', 'directive', 'sentenizer', 'transform']),
        node('utils'),
        node('vsc', ['html-extension', 'transform', 'yfmlint'], [], 'diplodoc-vsc-extension'),
        node('yfmlint', [], ['transform']),
        node('algolia-extension', ['search-extension'], ['cli']),
        node('color-extension'),
        node('cut-extension', ['directive', 'utils']),
        node('file-extension', ['directive']),
        node('folding-headings-extension', [], ['utils']),
        node('html-extension', ['directive']),
        node('latex-extension'),
        node('mermaid-extension'),
        node('openapi-extension', ['liquid']),
        node('page-constructor-extension', ['directive', 'utils']),
        node('quote-link-extension', ['utils']),
        node('search-extension', [], ['client', 'components']),
        node('tabs-extension', [], ['utils']),
    ];
}

test('all inventories 23 registered packages and extensions while excluding CLI and VSC', () => {
    const graph = platformGraph();
    const result = repositoryTargets(graph, ['all']);

    assert.equal(graph.length, 25);
    assert.deepEqual(
        result.repositories,
        graph
            .map((item) => item.repo)
            .filter((repo) => !['cli', 'vsc'].includes(repo))
            .sort(),
    );
    assert.deepEqual(result.unsupported, [
        {repo: 'vsc', reason: 'Standalone VSC updates require a separate candidate path'},
    ]);
    assert.throws(() => repositoryTargets(graph, ['vsc']), /Standalone VSC/);

    graph.find((item) => item.repo === 'cli').manifest.dependencies['diplodoc-vsc-extension'] = '*';
    assert.throws(() => repositoryTargets(graph, ['vsc']), /Standalone VSC/);
});

test('CLI build inputs include bundled yfmlint and search without treating all devDeps as inputs', () => {
    const graph = platformGraph();
    const cli = graph.find((item) => item.repo === 'cli');

    for (const repo of ['yfmlint', 'search-extension']) {
        const selected = graph.find((item) => item.repo === repo);

        assert.deepEqual(
            buildOrder(graph, [selected]).map((item) => item.repo),
            [repo, 'cli'],
        );
    }

    const tooling = node('tooling');
    cli.manifest.devDependencies[tooling.manifest.name] = '*';
    assert.throws(() => buildOrder([...graph, tooling], [tooling]), /not in the CLI build graph/);

    delete cli.manifest.devDependencies['@diplodoc/yfmlint'];
    const yfmlint = graph.find((item) => item.repo === 'yfmlint');
    assert.throws(() => buildOrder(graph, [yfmlint]), /not in the CLI build graph/);
});

test('client asset inputs remain in the model and their consumers are rebuilt', () => {
    const graph = platformGraph();
    const components = graph.find((item) => item.repo === 'components');

    assert.deepEqual(
        buildOrder(graph, [components]).map((item) => item.repo),
        ['components', 'client', 'cli'],
    );
});

test('only selected exact opt-in profiles add virtual CLI edges and source manifests stay frozen', () => {
    const graph = platformGraph();
    const original = structuredClone(graph);
    const cli = graph.find((item) => item.repo === 'cli');
    const utils = graph.find((item) => item.repo === 'utils');

    for (const profile of OPT_IN_EXTENSIONS) {
        assert.equal(optInExtension(profile.name), profile);
        const selected = graph.find((item) => item.repo === profile.repo);
        const edges = buildEdges(graph, [selected])(cli);

        assert.ok(edges.includes(profile.name));
        assert.deepEqual(
            buildOrder(graph, [selected]).map((item) => item.repo),
            [profile.repo, 'cli'],
        );
        assert.ok(
            OPT_IN_EXTENSIONS.filter((item) => item !== profile).every(
                (item) => !edges.includes(item.name),
            ),
        );
    }

    const ordinary = buildOrder(graph, [utils]).map((item) => item.repo);
    assert.ok(OPT_IN_EXTENSIONS.every((profile) => !ordinary.includes(profile.repo)));
    assert.deepEqual(graph, original);
    assert.equal(optInExtension('@diplodoc/unregistered-extension'), undefined);

    const forged = node('unrelated', [], [], '@diplodoc/html-extension');
    const replaced = graph.map((item) => (item.repo === 'html-extension' ? forged : item));
    assert.throws(() => buildOrder(replaced, [forged]), /not in the CLI build graph/);
});

test('build model retains optional dependency edges and rejects affected cycles', () => {
    const alpha = node('alpha', ['beta']);
    const beta = node('beta', ['alpha']);
    const cli = node('cli');
    cli.manifest.optionalDependencies = dependencies('alpha');

    assert.throws(() => buildOrder([alpha, beta, cli], [alpha]), /contains a cycle/);

    beta.manifest.dependencies = {};
    assert.deepEqual(
        buildOrder([alpha, beta, cli], [beta]).map((item) => item.repo),
        ['beta', 'alpha', 'cli'],
    );
});

module.exports = {tests};
