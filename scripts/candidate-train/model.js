'use strict';

const CLI_BUNDLED_INPUTS = Object.freeze([
    '@diplodoc/latex-extension',
    '@diplodoc/mermaid-extension',
    '@diplodoc/openapi-extension',
    '@diplodoc/page-constructor-extension',
    '@diplodoc/search-extension',
    '@diplodoc/yfmlint',
]);

const OPT_IN_EXTENSIONS = Object.freeze(
    [
        {repo: 'algolia-extension', name: '@diplodoc/algolia-extension', kind: 'cli'},
        {
            repo: 'folding-headings-extension',
            name: '@diplodoc/folding-headings-extension',
            kind: 'markdown-it',
        },
        {repo: 'html-extension', name: '@diplodoc/html-extension', kind: 'markdown-it'},
        {repo: 'quote-link-extension', name: '@diplodoc/quote-link-extension', kind: 'markdown-it'},
    ].map((profile) => Object.freeze(profile)),
);

const MODELED_RUNTIME_INPUTS = Object.freeze([
    Object.freeze({
        repo: 'folding-headings-extension',
        name: '@diplodoc/folding-headings-extension',
        dependencies: Object.freeze(['@diplodoc/utils']),
    }),
]);

/**
 * Look up the trusted integration profile for an exact package name.
 *
 * @param {string} name Package name.
 * @returns {object|undefined} The matching integration profile, when supported.
 */
function optInExtension(name) {
    return OPT_IN_EXTENSIONS.find((profile) => profile.name === name);
}

/**
 * Model build inputs without rewriting frozen source manifests. Only selected
 * opt-in extensions add virtual CLI edges; ordinary waves retain their baseline.
 *
 * @param {object[]} graph Frozen registered source packages.
 * @param {object[]} selected Source packages selected for the current wave.
 * @returns {Function} A resolver for each package's registered build inputs.
 */
function buildEdges(graph, selected) {
    const registered = new Map(graph.map((node) => [node.manifest.name, node]));
    const optInInputs = selected
        .filter((node) => {
            const profile = optInExtension(node.manifest.name);

            return (
                profile?.repo === node.repo &&
                registered.get(node.manifest.name)?.repo === profile.repo
            );
        })
        .map((node) => node.manifest.name);

    return (node) => {
        const dependencies = {
            ...node.manifest.dependencies,
            ...node.manifest.optionalDependencies,
            ...(node.repo === 'client' ? node.manifest.devDependencies : {}),
        };
        const runtimeInputs = MODELED_RUNTIME_INPUTS.find(
            (profile) => profile.repo === node.repo && profile.name === node.manifest.name,
        );

        for (const name of runtimeInputs?.dependencies || []) {
            if (Object.hasOwn(node.manifest.devDependencies || {}, name)) {
                dependencies[name] = node.manifest.devDependencies[name];
            }
        }

        if (node.repo === 'cli' && node.manifest.name === '@diplodoc/cli') {
            for (const name of CLI_BUNDLED_INPUTS) {
                if (Object.hasOwn(node.manifest.devDependencies || {}, name)) {
                    dependencies[name] = node.manifest.devDependencies[name];
                }
            }

            for (const name of optInInputs) {
                dependencies[name] = '*';
            }
        }

        return Object.keys(dependencies).filter((name) => registered.has(name));
    };
}

module.exports = {
    CLI_BUNDLED_INPUTS,
    OPT_IN_EXTENSIONS,
    MODELED_RUNTIME_INPUTS,
    optInExtension,
    buildEdges,
};
