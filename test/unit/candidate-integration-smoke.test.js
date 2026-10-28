const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {runInNewContext} = require('node:vm');

const smoke = require('../../scripts/candidate-train/integration-smoke');
const {OPT_IN_EXTENSIONS} = require('../../scripts/candidate-train/model');

const tests = [];
const test = (name, fn) => tests.push({name, fn});
const SHA = 'a'.repeat(40);
const profiles = () =>
    OPT_IN_EXTENSIONS.map((profile) => {
        const stem = {
            'folding-headings-extension': 'folding',
            'quote-link-extension': 'quote',
            'html-extension': 'html',
        }[profile.repo];
        let extensions = [];
        if (stem) {
            extensions = stem === 'html' ? ['js'] : ['js', 'css'];
        }
        return {
            ...profile,
            sourceSha: SHA,
            entry: `/candidate/${profile.repo}/plugin.cjs`,
            runtimes: extensions.map((extension) => ({
                destination: `_candidate-smoke/${stem}.${extension}`,
                content: Buffer.from(`candidate-${stem}-${extension}`),
            })),
        };
    });
const planFor = (items = profiles()) => ({
    selected: items.map((profile) => ({
        repo: profile.repo,
        sha: SHA,
        manifest: {name: profile.name},
    })),
});

function temporary(fn) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-integration-test-'));
    try {
        return fn(directory);
    } finally {
        fs.rmSync(directory, {recursive: true, force: true});
    }
}

function write(file, content) {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(
        file,
        typeof content === 'object' && !Buffer.isBuffer(content)
            ? JSON.stringify(content)
            : content,
    );
}

function stateScript(state) {
    const json = JSON.stringify(state)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    return `<script type="application/json" id="diplodoc-state">${json}</script>`;
}

function artifactsFor(items) {
    const enabled = new Set(items.map((profile) => profile.repo));
    let html = `<p>${smoke.MARKERS.base}</p>`;
    const assets = {};
    let resources = '';

    if (enabled.has('folding-headings-extension')) {
        html += `<section class="heading-section" data-diplodoc-key="heading-section" data-diplodoc-id="smoke-id"><h2>Folding smoke</h2><div class="heading-section-content"><p>${smoke.MARKERS.folding}</p></div></section>`;
    }
    if (enabled.has('quote-link-extension')) {
        html += `<blockquote class="yfm-quote-link"><p><a href="https://example.invalid/" data-quotelink>Quote smoke</a></p><p>${smoke.MARKERS.quote}</p></blockquote>`;
    }
    if (enabled.has('html-extension')) {
        const srcdoc = `<html><body><p id="candidate-html-marker">${smoke.MARKERS.html}</p></body></html>`;
        html += `<iframe data-yfm-sandbox-mode="srcdoc" srcdoc="${srcdoc.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}"></iframe>`;
    }
    for (const profile of items) {
        for (const runtime of profile.runtimes) {
            assets[runtime.destination] = runtime.content;
            resources += runtime.destination.endsWith('.css')
                ? `<link rel="stylesheet" href="${runtime.destination}">`
                : `<script src="${runtime.destination}"></script>`;
        }
    }

    const search = enabled.has('algolia-extension')
        ? {provider: 'algolia', appId: 'CANDIDATESMOKE', indexName: 'candidate-smoke-en'}
        : undefined;
    if (search) {
        resources += '<script src="_search/api.js"></script>';
    }

    return {
        html: resources + stateScript({data: {html}, search}),
        md: smoke.smokeDefinition(items, '/input', '/output').markdown,
        assets,
        searchIndex: JSON.stringify([
            {lang: 'en', url: 'en/index.html', content: smoke.MARKERS.base},
        ]),
        searchPage: search ? stateScript(search) : undefined,
        searchApi: '/* browser search API */',
    };
}

function fakeCandidate(directory, items) {
    const cli = path.join(directory, 'cli');
    write(path.join(cli, 'package.json'), {
        name: '@diplodoc/cli',
        exports: {'.': './build/index.js', './package': './package.json'},
    });
    write(path.join(cli, 'build/index.js'), 'module.exports = {};');

    for (const profile of items) {
        const root = path.join(cli, 'node_modules', profile.name);
        const exports = {'.': './plugin.cjs'};
        const runtimes = [];
        if (profile.kind === 'markdown-it') {
            const stem = {
                'folding-headings-extension': 'folding',
                'quote-link-extension': 'quote',
                'html-extension': 'html',
            }[profile.repo];
            exports['./runtime'] = './runtime.js';
            write(path.join(root, 'runtime.js'), `/* ${profile.repo} script */`);
            runtimes.push({
                destination: `_candidate-smoke/${stem}.js`,
                content: Buffer.from(`/* ${profile.repo} script */`),
            });
            if (stem !== 'html') {
                exports['./runtime/styles.css'] = './runtime.css';
                write(path.join(root, 'runtime.css'), `/* ${profile.repo} stylesheet */`);
                runtimes.push({
                    destination: `_candidate-smoke/${stem}.css`,
                    content: Buffer.from(`/* ${profile.repo} stylesheet */`),
                });
            }
        }
        write(path.join(root, 'package.json'), {
            name: profile.name,
            exports,
            dependencyTrain: {sourceSha: SHA},
        });
        write(path.join(root, 'plugin.cjs'), 'module.exports = {};');
        profile.runtimes = runtimes;
    }

    return cli;
}

test('fixture conditionally activates every opt-in through the real extension APIs', () => {
    for (const selected of [[], ...profiles().map((profile) => [profile]), profiles()]) {
        const fixture = smoke.smokeDefinition(selected, '/scratch/input', '/scratch/html');
        assert.equal(fixture.config.allowHtml, true);
        assert.equal(
            fixture.config.sanitizeHtml,
            undefined,
            'Smoke must retain the CLI sanitizer default',
        );
        const markdownProfiles = selected.filter((profile) => profile.kind === 'markdown-it');
        assert.equal(Object.keys(fixture.adapters).length, markdownProfiles.length);
        const mdit = fixture.config.extensions.find(
            (extension) => extension.name === 'mdit-plugins',
        );
        assert.equal(mdit?.plugins.length || 0, markdownProfiles.length);

        for (const profile of markdownProfiles) {
            const filename = `${profile.repo}.cjs`;
            let configured = false;
            let applied = false;
            const factory = (options) => {
                configured = true;
                assert.ok(
                    !Object.values(options).some(
                        (value) => typeof value === 'string' && value.startsWith('_assets/'),
                    ),
                );
                return (md, opts) => {
                    applied = true;
                    assert.equal(opts.output, '/scratch/html');
                    assert.equal(opts.generateID(), 'shared-id');
                };
            };
            const sandbox = {
                module: {exports: {}},
                require: (name) => {
                    assert.equal(name, profile.entry);
                    return {transform: factory};
                },
            };
            runInNewContext(fixture.adapters[filename], sandbox);
            const md = {
                use(plugin, opts) {
                    plugin(this, opts);
                },
            };
            sandbox.module.exports(md, {output: '/scratch/html', generateID: () => 'shared-id'});
            assert.ok(
                configured && applied,
                'Adapter must construct and apply the transform plugin',
            );
            assert.equal(
                mdit.plugins.find((plugin) => plugin.resolver === `./${filename}`).options.output,
                '/scratch/html',
            );
        }

        const algolia = selected.some((profile) => profile.repo === 'algolia-extension');
        assert.equal(
            fixture.config.extensions.some((extension) =>
                extension.name.includes('algolia-extension'),
            ),
            algolia,
        );
        if (algolia) {
            assert.equal(fixture.config.search.index, false);
            assert.equal(fixture.config.search.provider, 'algolia');
            assert.equal(fixture.config.search.apiKey, undefined);
            assert.equal(fixture.config.search.searchApiKey, undefined);
        } else {
            assert.equal(fixture.config.search, false);
        }
    }
});

test('semantic verification rejects missing activation even when all source markers survive', () => {
    for (const profile of profiles()) {
        const all = [profile];
        const artifacts = artifactsFor(all);
        assert.deepEqual(
            smoke.verifySmokeArtifacts(all, artifacts),
            smoke.expectedIntegrationEvidence(planFor(all)),
        );

        if (profile.repo === 'algolia-extension') {
            artifacts.html = stateScript({
                data: {html: `<p>${Object.values(smoke.MARKERS).join(' ')}</p>`},
                search: {provider: 'local'},
            });
        } else {
            artifacts.html = stateScript({
                data: {html: `<p>${Object.values(smoke.MARKERS).join(' ')}</p>`},
            });
        }
        assert.throws(() => smoke.verifySmokeArtifacts(all, artifacts), /was not activated/);
    }
});

test('runtime output must match candidate bytes and be attached to the page', () => {
    const all = profiles().filter((profile) => profile.repo === 'html-extension');
    all[0].runtimes = [
        {destination: '_candidate-smoke/html.js', content: Buffer.from('candidate-runtime')},
    ];

    for (const mutation of ['missing', 'wrong-bytes', 'unattached', 'lost-md']) {
        const artifacts = artifactsFor(all);
        if (mutation === 'missing') {
            delete artifacts.assets['_candidate-smoke/html.js'];
        }
        if (mutation === 'wrong-bytes') {
            artifacts.assets['_candidate-smoke/html.js'] = Buffer.from('registry-runtime');
        }
        if (mutation === 'unattached') {
            artifacts.html = artifacts.html.replace(
                '<script src="_candidate-smoke/html.js"></script>',
                '',
            );
        }
        if (mutation === 'lost-md') {
            artifacts.md = smoke.MARKERS.base;
        }
        assert.throws(
            () => smoke.verifySmokeArtifacts(all, artifacts),
            /Runtime asset|lost HTML directive/,
        );
    }
});

test('composition with missing plugin runtimes is rejected even when both features rendered', () => {
    const selected = profiles().filter((profile) =>
        ['folding-headings-extension', 'quote-link-extension'].includes(profile.repo),
    );
    const artifacts = artifactsFor(selected);
    // Published plugins share relative ../runtime cache keys on the same page.
    // Independent fixtures do not claim this composition works.
    delete artifacts.assets['_candidate-smoke/quote.js'];
    delete artifacts.assets['_candidate-smoke/quote.css'];

    assert.throws(
        () => smoke.verifySmokeArtifacts(selected, artifacts),
        /Runtime asset is missing: _candidate-smoke\/quote.js/,
    );
});

test('an HTML iframe with content stripped by the outer sanitizer cannot pass', () => {
    const selected = profiles().filter((profile) => profile.repo === 'html-extension');
    const artifacts = artifactsFor(selected);
    const resource = '<script src="_candidate-smoke/html.js"></script>';
    artifacts.html =
        resource +
        stateScript({
            data: {
                html: `<p>${smoke.MARKERS.base}</p><iframe data-yfm-sandbox-mode="srcdoc"></iframe>`,
            },
        });

    assert.throws(
        () => smoke.verifySmokeArtifacts(selected, artifacts),
        /HTML extension was not activated/,
    );
});

test('Algolia needs a local record, search page and browser API, with no exposed keys', () => {
    const all = profiles().filter((profile) => profile.repo === 'algolia-extension');

    for (const mutation of ['no-records', 'wrong-url', 'no-search-page', 'no-api', 'key']) {
        const artifacts = artifactsFor(all);
        if (mutation === 'no-records') {
            artifacts.searchIndex = '[]';
        }
        if (mutation === 'wrong-url') {
            artifacts.searchIndex = artifacts.searchIndex.replace('en/index.html', 'wrong.html');
        }
        if (mutation === 'no-search-page') {
            artifacts.searchPage = '';
        }
        if (mutation === 'no-api') {
            artifacts.searchApi = '';
        }
        if (mutation === 'key') {
            artifacts.html = artifacts.html.replace(
                '"provider":"algolia"',
                '"provider":"algolia","apiKey":"unexpected-key"',
            );
        }
        assert.throws(
            () => smoke.verifySmokeArtifacts(all, artifacts),
            /Algolia|API key|generated page state/,
        );
    }
});

test('standalone smoke checks each configuration in HTML and MD, then removes its exact host link', () =>
    temporary((directory) => {
        const all = profiles();
        const cli = fakeCandidate(directory, all);
        const scratch = path.join(directory, 'scratch');
        fs.mkdirSync(scratch);
        const invocations = [];
        const run = (command, args, cwd) => {
            assert.equal(command, 'node');
            assert.equal(cwd, cli);
            assert.equal(args[0], '--require');
            assert.match(fs.readFileSync(args[1], 'utf8'), /Network access is forbidden/);
            assert.equal(
                fs.realpathSync(path.join(cli, 'node_modules/@diplodoc/cli')),
                fs.realpathSync(cli),
            );
            const output = args[args.indexOf('-o') + 1];
            const format = args[args.indexOf('--output-format') + 1];
            const active = all.filter(
                (profile) => profile.repo === path.basename(path.dirname(output)),
            );
            assert.equal(active.length, 1, 'Each opt-in needs an independent configuration');
            const outputs = artifactsFor(active);
            const config = JSON.parse(fs.readFileSync(args[args.indexOf('--config') + 1], 'utf8'));
            for (const plugin of config.extensions.find((item) => item.name === 'mdit-plugins')
                ?.plugins || []) {
                assert.equal(plugin.options.output, output);
            }
            invocations.push(format);

            if (format === 'md') {
                return write(path.join(output, 'en/index.md'), outputs.md);
            }
            write(path.join(output, 'en/index.html'), outputs.html);
            for (const [file, content] of Object.entries(outputs.assets)) {
                write(path.join(output, file), content);
            }
            if (active[0].kind === 'cli') {
                write(path.join(output, '_search/en-algolia.json'), outputs.searchIndex);
                write(path.join(output, '_search/en/index.html'), outputs.searchPage);
                write(path.join(output, '_search/api.js'), outputs.searchApi);
            }
        };

        assert.deepEqual(
            smoke.runIntegrationSmoke(planFor(all), cli, scratch, run),
            smoke.expectedIntegrationEvidence(planFor(all)),
        );
        assert.deepEqual(
            invocations,
            all.flatMap(() => ['html', 'md']),
        );
        assert.equal(fs.existsSync(path.join(cli, 'node_modules/@diplodoc/cli')), false);
        assert.equal(fs.existsSync(path.join(cli, 'dependency-train')), false);
    }));

test('missing package, registry provenance and a no-op CLI runner cannot pass', () =>
    temporary((directory) => {
        const all = profiles().filter((profile) => profile.repo === 'html-extension');
        const cli = fakeCandidate(directory, all);
        const scratch = path.join(directory, 'scratch');
        fs.mkdirSync(scratch);
        assert.throws(
            () => smoke.runIntegrationSmoke(planFor(all), cli, scratch, () => {}),
            /HTML smoke output is missing/,
        );

        const manifest = path.join(cli, 'node_modules', all[0].name, 'package.json');
        const content = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        delete content.dependencyTrain;
        write(manifest, content);
        assert.throws(
            () => smoke.runIntegrationSmoke(planFor(all), cli, scratch, () => {}),
            /not the selected candidate/,
        );
        fs.rmSync(path.dirname(manifest), {recursive: true});
        assert.throws(
            () => smoke.runIntegrationSmoke(planFor(all), cli, scratch, () => {}),
            /ENOENT/,
        );
    }));

test('wrong or dangling existing CLI hosts are rejected without replacing user files', () =>
    temporary((directory) => {
        const cli = path.join(directory, 'cli');
        const host = path.join(cli, 'node_modules/@diplodoc/cli');
        write(path.join(cli, 'package.json'), {name: '@diplodoc/cli'});
        write(path.join(host, 'package.json'), {name: '@diplodoc/cli', version: 'registry'});
        assert.throws(() => smoke.ensureCliHost(cli), /not the exact candidate/);
        assert.equal(
            JSON.parse(fs.readFileSync(path.join(host, 'package.json'))).version,
            'registry',
        );
        fs.rmSync(host, {recursive: true});
        fs.symlinkSync(
            path.join(directory, 'missing'),
            host,
            process.platform === 'win32' ? 'junction' : 'dir',
        );
        assert.throws(() => smoke.ensureCliHost(cli), /not the exact candidate/);
        assert.ok(fs.lstatSync(host).isSymbolicLink());
    }));

test('exact existing CLI host is preserved and a failed smoke removes its temporary host', () =>
    temporary((directory) => {
        const all = profiles().filter((profile) => profile.repo === 'algolia-extension');
        const cli = fakeCandidate(directory, all);
        const host = path.join(cli, 'node_modules/@diplodoc/cli');
        fs.symlinkSync(cli, host, process.platform === 'win32' ? 'junction' : 'dir');
        smoke.ensureCliHost(cli)();
        assert.equal(fs.realpathSync(host), fs.realpathSync(cli));
        fs.unlinkSync(host);
        const scratch = path.join(directory, 'scratch');
        fs.mkdirSync(scratch);
        assert.throws(
            () =>
                smoke.runIntegrationSmoke(planFor(all), cli, scratch, () => {
                    throw new Error('CLI failed');
                }),
            /CLI failed/,
        );
        assert.equal(fs.existsSync(host), false);
    }));

test('a nested registry CLI cannot shadow the exact host for Algolia', () =>
    temporary((directory) => {
        const all = profiles().filter((profile) => profile.repo === 'algolia-extension');
        const cli = fakeCandidate(directory, all);
        const nested = path.join(cli, 'node_modules', all[0].name, 'node_modules/@diplodoc/cli');
        write(path.join(nested, 'package.json'), {
            name: '@diplodoc/cli',
            exports: {'./package': './package.json'},
        });
        const scratch = path.join(directory, 'scratch');
        fs.mkdirSync(scratch);

        assert.throws(
            () => smoke.runIntegrationSmoke(planFor(all), cli, scratch, () => {}),
            /other than the exact candidate/,
        );
        assert.ok(fs.existsSync(path.join(nested, 'package.json')));
        assert.equal(fs.existsSync(path.join(cli, 'node_modules/@diplodoc/cli')), false);
    }));

test('ordinary waves retain HTML and MD validation without claiming opt-in integration evidence', () =>
    temporary((directory) => {
        const cli = fakeCandidate(directory, []);
        const scratch = path.join(directory, 'scratch');
        fs.mkdirSync(scratch);
        const artifacts = artifactsFor([]);
        let calls = 0;
        const evidence = smoke.runIntegrationSmoke(planFor([]), cli, scratch, (_command, args) => {
            calls++;
            const output = args[args.indexOf('-o') + 1];
            const md = args.at(-1) === 'md';
            write(
                path.join(output, md ? 'en/index.md' : 'en/index.html'),
                md ? artifacts.md : artifacts.html,
            );
        });
        assert.equal(calls, 2);
        assert.deepEqual(evidence, []);
        assert.deepEqual(smoke.expectedIntegrationEvidence(planFor([])), []);
    }));

test('offline preload clears inherited Algolia configuration and blocks HTTP, fetch and sockets', () =>
    temporary((directory) => {
        const guard = path.join(directory, 'offline.cjs');
        write(guard, smoke.offlineGuardSource());
        const script = `
        const assert = require('node:assert/strict');
        assert.equal(process.env.ALGOLIA_API_KEY, undefined);
        assert.equal(process.env.ALGOLIA_PROVIDER, undefined);
        for (const fn of [() => require('node:http').get('http://example.invalid'), () => require('node:https').request('https://example.invalid'), () => fetch('https://example.invalid'), () => require('node:net').connect(443, 'example.invalid')]) {
            assert.throws(fn, /Network access is forbidden/);
        }
        const {Worker} = require('node:worker_threads');
        const worker = new Worker(${JSON.stringify("const assert = require('node:assert/strict'); const net = require('node:net'); assert.match(String(net.connect), /Network access is forbidden/); assert.throws(() => net.connect(443, 'example.invalid'), /Network access is forbidden/); assert.equal(process.env.ALGOLIA_API_KEY, undefined);")}, {eval: true});
        worker.on('error', (error) => { throw error; });
    `;
        execFileSync(process.execPath, ['--require', guard, '-e', script], {
            env: {
                ...process.env,
                ALGOLIA_API_KEY: 'fixture-key',
                ALGOLIA_PROVIDER: 'unexpected-provider',
            },
            timeout: 10000,
            stdio: 'pipe',
        });
    }));

module.exports = {tests};
