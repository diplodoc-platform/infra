'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');
const {optInExtension} = require('./model');

const MARKERS = Object.freeze({
    base: 'Candidate searchable integration marker.',
    folding: 'Candidate folding integration marker.',
    quote: 'Candidate quote integration marker.',
    html: 'Candidate HTML integration marker.',
});

const RUNTIMES = Object.freeze({
    'folding-headings-extension': [
        ['runtime', '_candidate-smoke/folding.js'],
        ['runtime/styles.css', '_candidate-smoke/folding.css'],
    ],
    'quote-link-extension': [
        ['runtime', '_candidate-smoke/quote.js'],
        ['runtime/styles.css', '_candidate-smoke/quote.css'],
    ],
    'html-extension': [['runtime', '_candidate-smoke/html.js']],
});

function selectedProfiles(plan) {
    return plan.selected.flatMap((node) => {
        const profile = optInExtension(node.manifest.name);
        if (!profile) {
            return [];
        }
        assert.equal(profile.repo, node.repo, 'Opt-in source does not match its package');
        return [{...profile, sourceSha: node.sha}];
    });
}

// Expected fixture coverage; the publisher can independently require it.
function expectedIntegrationEvidence(plan) {
    const checks = {
        'folding-headings-extension': ['folding-section', 'runtime-assets'],
        'quote-link-extension': ['quote-link-block', 'runtime-assets'],
        'html-extension': ['html-srcdoc', 'runtime-assets'],
        'algolia-extension': ['algolia-provider', 'algolia-local-index', 'algolia-search-page'],
    };

    return selectedProfiles(plan).map((profile) => ({
        repo: profile.repo,
        name: profile.name,
        sourceSha: profile.sourceSha,
        scope: 'generated-fixture',
        formats: ['html', 'md'],
        checks: ['markdown-preservation', ...checks[profile.repo]],
    }));
}

// Generate configuration and adapters without loading candidate package code.
function smokeDefinition(profiles, input, output) {
    const markdown = ['# Candidate integration smoke', '', MARKERS.base, ''];
    const extensions = [];
    const adapters = {};
    const config = {lang: 'en', langs: ['en'], allowHtml: true, extensions, search: false};
    const plugins = [];

    for (const profile of profiles) {
        if (profile.repo === 'algolia-extension') {
            extensions.push({name: profile.entry});
            config.search = {
                enabled: true,
                provider: 'algolia',
                appId: 'CANDIDATESMOKE',
                indexName: 'candidate-smoke',
                index: false,
            };
            continue;
        }

        let options;
        if (profile.repo === 'folding-headings-extension') {
            markdown.push('##+ Folding smoke', '', MARKERS.folding, '');
            options = {
                runtime: {
                    script: '_candidate-smoke/folding.js',
                    style: '_candidate-smoke/folding.css',
                },
            };
        } else if (profile.repo === 'quote-link-extension') {
            markdown.push(
                '## Quote smoke',
                '',
                '> [Quote smoke](https://example.invalid/){data-quotelink}',
                '>',
                `> ${MARKERS.quote}`,
                '',
            );
            options = {
                runtime: {script: '_candidate-smoke/quote.js', style: '_candidate-smoke/quote.css'},
            };
        } else if (profile.repo === 'html-extension') {
            markdown.push(
                '## HTML smoke',
                '',
                '::: html',
                '',
                `<p id="candidate-html-marker">${MARKERS.html}</p>`,
                '',
                ':::',
                '',
            );
            options = {runtimeJsPath: '_candidate-smoke/html.js'};
        } else {
            assert.fail(`Unsupported opt-in smoke: ${profile.repo}`);
        }

        const filename = `${profile.repo}.cjs`;
        adapters[filename] =
            `'use strict';\nconst {transform} = require(${JSON.stringify(profile.entry)});\n` +
            `module.exports = (md, opts) => {\n` +
            `    md.use(transform(${JSON.stringify(options)}), opts);\n};\n`;
        plugins.push({resolver: `./${filename}`, options: {output}});
    }

    if (plugins.length) {
        extensions.push({name: 'mdit-plugins', plugins});
    }

    return {
        input,
        output,
        config,
        adapters,
        markdown: markdown.join('\n'),
        toc: 'title: Candidate integration smoke\nitems:\n  - name: Smoke\n    href: index.md\n',
    };
}

function within(root, file) {
    const relative = path.relative(root, file);
    return (
        relative === '' ||
        (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
    );
}

function installedProfiles(plan, cliDirectory) {
    const root = fs.realpathSync(cliDirectory);
    const resolve = createRequire(path.join(root, 'package.json')).resolve;

    return selectedProfiles(plan).map((profile) => {
        const directory = fs.realpathSync(path.join(root, 'node_modules', profile.name));
        assert.ok(within(root, directory), `Opt-in package escaped the candidate: ${profile.name}`);
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
        assert.equal(manifest.name, profile.name);
        assert.equal(
            manifest.dependencyTrain?.sourceSha,
            profile.sourceSha,
            `Opt-in package is not the selected candidate: ${profile.name}`,
        );

        const entry = fs.realpathSync(resolve(profile.name));
        assert.ok(within(directory, entry), `Opt-in entry escaped its package: ${profile.name}`);
        const runtimes = (RUNTIMES[profile.repo] || []).map(([subpath, destination]) => {
            const source = fs.realpathSync(resolve(`${profile.name}/${subpath}`));
            assert.ok(within(directory, source), `Runtime escaped its package: ${profile.name}`);
            return {destination, content: fs.readFileSync(source)};
        });

        return {...profile, directory, entry, runtimes};
    });
}

// Give external extensions the built host, rejecting an existing registry CLI.
function ensureCliHost(cliDirectory) {
    const root = fs.realpathSync(cliDirectory);
    const host = path.join(root, 'node_modules', '@diplodoc', 'cli');
    let created = false;

    try {
        fs.lstatSync(host);
        assert.equal(fs.realpathSync(host), root, 'Existing CLI host is not the exact candidate');
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
        // A dangling link also returns ENOENT from realpath; never replace it.
        assert.ok(
            !fs.existsSync(path.dirname(host)) ||
                !fs.readdirSync(path.dirname(host)).includes('cli'),
            'Existing CLI host is not the exact candidate',
        );
        fs.mkdirSync(path.dirname(host), {recursive: true});
        fs.symlinkSync(root, host, process.platform === 'win32' ? 'junction' : 'dir');
        created = true;
    }

    return () => {
        if (created) {
            assert.equal(fs.realpathSync(host), root, 'Temporary CLI host changed during smoke');
            fs.unlinkSync(host);
        }
    };
}

function offlineGuardSource() {
    return `'use strict';
for (const key of Object.keys(process.env)) {
    if (key.toUpperCase().startsWith('ALGOLIA_')) delete process.env[key];
}
const blocked = () => { throw new Error('Network access is forbidden in candidate integration smoke'); };
for (const name of ['node:http', 'node:https']) {
    const module = require(name);
    module.request = blocked;
    module.get = blocked;
}
const net = require('node:net');
net.connect = blocked;
net.createConnection = blocked;
net.Socket.prototype.connect = blocked;
require('node:tls').connect = blocked;
globalThis.fetch = blocked;
require('node:module').syncBuiltinESMExports();
`;
}

function decodeHtml(value) {
    return value
        .replace(/&#(x[0-9a-f]+|\d+);/gi, (_match, code) =>
            String.fromCodePoint(
                code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code),
            ),
        )
        .replace(/&quot;/g, '"')
        .replace(/&apos;|&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

function attributes(source) {
    return Object.fromEntries(
        [...source.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)].map(
            ([, name, double, single, bare]) => [
                name.toLowerCase(),
                decodeHtml(double ?? single ?? bare ?? ''),
            ],
        ),
    );
}

function pageState(html) {
    for (const [, source, content] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
        const attrs = attributes(source);
        if (attrs.id === 'diplodoc-state' && attrs.type === 'application/json') {
            // Template.escape escapes only these three entities in JSON text.
            return JSON.parse(
                content.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'),
            );
        }
    }
    assert.fail('HTML smoke is missing the generated page state');
}

function tags(html, tag) {
    return [
        ...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}\\s*>`, 'gi')),
    ].map(([, source, content]) => ({attrs: attributes(source), content}));
}

function classIs(attrs, name) {
    return (attrs.class || '').split(/\s+/).includes(name);
}

// Check generated contents and runtime bytes; no package code is executed here.
function verifySmokeArtifacts(profiles, artifacts) {
    assert.equal(typeof artifacts.html, 'string', 'HTML smoke output is missing');
    assert.equal(typeof artifacts.md, 'string', 'Markdown smoke output is missing');
    const state = pageState(artifacts.html);
    const html = state.data?.html;
    assert.equal(typeof html, 'string', 'HTML smoke did not contain transformed Markdown');
    assert.ok(html.includes(MARKERS.base), 'HTML smoke lost the source content');
    assert.ok(artifacts.md.includes(MARKERS.base), 'Markdown smoke lost the source content');

    return profiles.map((profile) => {
        const checks = ['markdown-preservation'];

        if (profile.repo === 'folding-headings-extension') {
            const section = tags(html, 'section').find(
                ({attrs, content}) =>
                    classIs(attrs, 'heading-section') &&
                    attrs['data-diplodoc-key'] === 'heading-section' &&
                    attrs['data-diplodoc-id'] &&
                    tags(content, 'div').some(
                        (div) =>
                            classIs(div.attrs, 'heading-section-content') &&
                            div.content.includes(MARKERS.folding),
                    ),
            );
            assert.ok(section, 'Folding headings extension was not activated');
            assert.ok(
                artifacts.md.includes('##+ Folding smoke') &&
                    artifacts.md.includes(MARKERS.folding),
                'Markdown smoke lost folding syntax',
            );
            checks.push('folding-section');
        } else if (profile.repo === 'quote-link-extension') {
            const quote = tags(html, 'blockquote').find(
                ({attrs, content}) =>
                    classIs(attrs, 'yfm-quote-link') &&
                    content.includes(MARKERS.quote) &&
                    tags(content, 'a').some(
                        (link) =>
                            Object.hasOwn(link.attrs, 'data-quotelink') &&
                            link.attrs.href === 'https://example.invalid/',
                    ),
            );
            assert.ok(quote, 'Quote link extension was not activated');
            assert.ok(
                artifacts.md.includes('{data-quotelink}') && artifacts.md.includes(MARKERS.quote),
                'Markdown smoke lost quote link syntax',
            );
            checks.push('quote-link-block');
        } else if (profile.repo === 'html-extension') {
            const iframe = tags(html, 'iframe').find(
                ({attrs}) =>
                    attrs['data-yfm-sandbox-mode'] === 'srcdoc' &&
                    tags(attrs.srcdoc || '', 'p').some(
                        (paragraph) =>
                            paragraph.attrs.id === 'candidate-html-marker' &&
                            paragraph.content === MARKERS.html,
                    ),
            );
            assert.ok(iframe, 'HTML extension was not activated');
            assert.ok(
                artifacts.md.includes('::: html') && artifacts.md.includes(MARKERS.html),
                'Markdown smoke lost HTML directive syntax',
            );
            checks.push('html-srcdoc');
        } else if (profile.repo === 'algolia-extension') {
            assert.equal(
                state.search?.provider,
                'algolia',
                'Algolia search provider was not activated',
            );
            assert.equal(state.search.appId, 'CANDIDATESMOKE');
            assert.equal(state.search.indexName, 'candidate-smoke-en');
            assert.ok(
                !state.search.apiKey && !state.search.searchApiKey,
                'Search smoke exposed an API key',
            );
            const records = JSON.parse(artifacts.searchIndex || 'null');
            assert.ok(
                Array.isArray(records) &&
                    records.some(
                        (record) =>
                            record.lang === 'en' &&
                            record.url === 'en/index.html' &&
                            typeof record.content === 'string' &&
                            record.content.includes(MARKERS.base),
                    ),
                'Algolia did not generate a local search record',
            );
            const search = pageState(artifacts.searchPage || '');
            assert.equal(search.provider, 'algolia', 'Algolia search page was not generated');
            assert.equal(search.indexName, 'candidate-smoke-en');
            assert.ok(
                typeof artifacts.searchApi === 'string' && artifacts.searchApi.length > 0,
                'Algolia browser API asset is missing',
            );
            assert.ok(
                [...artifacts.html.matchAll(/<script\b([^>]*)>/gi)].some(
                    ([, source]) => attributes(source).src === '_search/api.js',
                ),
                'Algolia browser API was not attached',
            );
            checks.push('algolia-provider', 'algolia-local-index', 'algolia-search-page');
        } else {
            assert.fail(`Unsupported opt-in smoke: ${profile.repo}`);
        }

        for (const {destination, content} of profile.runtimes) {
            const asset = artifacts.assets[destination];
            assert.ok(asset, `Runtime asset is missing: ${destination}`);
            assert.deepEqual(
                asset,
                content,
                `Runtime asset differs from the candidate: ${destination}`,
            );
            const tag = destination.endsWith('.css') ? 'link' : 'script';
            const attribute = tag === 'link' ? 'href' : 'src';
            assert.ok(
                [...artifacts.html.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'gi'))].some(
                    ([, source]) => attributes(source)[attribute] === destination,
                ),
                `Runtime asset was not attached: ${destination}`,
            );
        }
        if (profile.runtimes.length) {
            checks.push('runtime-assets');
        }

        return {
            repo: profile.repo,
            name: profile.name,
            sourceSha: profile.sourceSha,
            scope: 'generated-fixture',
            formats: ['html', 'md'],
            checks,
        };
    });
}

function readOptional(file, encoding) {
    return fs.existsSync(file) ? fs.readFileSync(file, encoding) : undefined;
}

function runSmokeFixture(profiles, cliDirectory, directory, run) {
    const input = path.join(directory, 'input');
    const htmlOutput = path.join(directory, 'html');
    const mdOutput = path.join(directory, 'md');
    assert.ok(!fs.existsSync(directory), 'Integration smoke requires a fresh fixture');
    fs.mkdirSync(path.join(input, 'en'), {recursive: true});

    const htmlFixture = smokeDefinition(profiles, input, htmlOutput);
    const mdFixture = smokeDefinition(profiles, input, mdOutput);
    fs.writeFileSync(path.join(input, 'en', 'index.md'), htmlFixture.markdown);
    fs.writeFileSync(path.join(input, 'en', 'toc.yaml'), htmlFixture.toc);
    for (const [filename, source] of Object.entries(htmlFixture.adapters)) {
        fs.writeFileSync(path.join(input, filename), source);
    }
    const htmlConfig = path.join(directory, 'html.yfm');
    const mdConfig = path.join(directory, 'md.yfm');
    fs.writeFileSync(htmlConfig, JSON.stringify(htmlFixture.config));
    fs.writeFileSync(mdConfig, JSON.stringify(mdFixture.config));
    const guard = path.join(directory, 'offline-guard.cjs');
    fs.writeFileSync(guard, offlineGuardSource());

    for (const [format, output, config] of [
        ['html', htmlOutput, htmlConfig],
        ['md', mdOutput, mdConfig],
    ]) {
        run(
            'node',
            [
                '--require',
                guard,
                'build/index.js',
                'build',
                '-i',
                input,
                '-o',
                output,
                '--config',
                config,
                '--output-format',
                format,
            ],
            cliDirectory,
        );
    }

    const assets = {};
    for (const profile of profiles) {
        for (const {destination} of profile.runtimes) {
            assets[destination] = readOptional(path.join(htmlOutput, destination));
        }
    }

    return verifySmokeArtifacts(profiles, {
        html: readOptional(path.join(htmlOutput, 'en', 'index.html'), 'utf8'),
        md: readOptional(path.join(mdOutput, 'en', 'index.md'), 'utf8'),
        assets,
        searchIndex: readOptional(path.join(htmlOutput, '_search', 'en-algolia.json'), 'utf8'),
        searchPage: readOptional(path.join(htmlOutput, '_search', 'en', 'index.html'), 'utf8'),
        searchApi: readOptional(path.join(htmlOutput, '_search', 'api.js'), 'utf8'),
    });
}

// Each opt-in uses its own configuration; this does not prove same-page composition.
// All selected archives remain installed in the same exact candidate CLI.
function runIntegrationSmoke(plan, cliDirectory, scratch, run) {
    const profiles = installedProfiles(plan, cliDirectory);
    const directory = path.join(scratch, 'candidate-integration-smoke');
    assert.ok(!fs.existsSync(directory), 'Integration smoke requires a fresh fixture');
    const cleanup = profiles.some((profile) => profile.repo === 'algolia-extension')
        ? ensureCliHost(cliDirectory)
        : () => {};

    try {
        for (const profile of profiles.filter((item) => item.kind === 'cli')) {
            const hostManifest = createRequire(profile.entry).resolve('@diplodoc/cli/package');
            assert.equal(
                fs.realpathSync(hostManifest),
                fs.realpathSync(path.join(cliDirectory, 'package.json')),
                'Extension resolved a CLI host other than the exact candidate',
            );
        }

        const fixtures = profiles.length ? profiles.map((profile) => [profile]) : [[]];
        return fixtures.flatMap((fixture) =>
            runSmokeFixture(
                fixture,
                cliDirectory,
                path.join(directory, fixture[0]?.repo || 'base'),
                run,
            ),
        );
    } finally {
        cleanup();
    }
}

module.exports = {
    MARKERS,
    selectedProfiles,
    expectedIntegrationEvidence,
    smokeDefinition,
    ensureCliHost,
    offlineGuardSource,
    verifySmokeArtifacts,
    runIntegrationSmoke,
};
