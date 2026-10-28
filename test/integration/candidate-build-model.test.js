const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {buildOrder, write} = require('../../scripts/candidate-train/common');
const {withArchives, installed, verifyLockedTree} = require('../../scripts/candidate-train/build');

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-build-model-'));
    const command = (args, cwd) =>
        execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
            cwd,
            encoding: 'utf8',
            shell: process.platform === 'win32',
            timeout: 120_000,
            env: {
                ...process.env,
                GH_TOKEN: '',
                GITHUB_TOKEN: '',
                npm_config_cache: path.join(root, 'cache'),
                npm_config_offline: 'true',
                npm_config_audit: 'false',
                npm_config_fund: 'false',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    const directory = (name) => {
        const result = path.join(root, name);
        fs.mkdirSync(result, {recursive: true});
        return result;
    };
    const pack = (name, manifest, code) => {
        const source = directory(name);
        write(path.join(source, 'package.json'), {main: 'index.js', ...manifest});
        fs.writeFileSync(path.join(source, 'index.js'), code);
        const result = JSON.parse(command(['pack', '--ignore-scripts', '--json'], source));
        return path.join(source, result[0].filename);
    };
    const install = (cwd, clean = false) =>
        command([clean ? 'ci' : 'install', '--include=dev', '--ignore-scripts', '--offline'], cwd);

    return {root, command, directory, pack, install};
}

const tests = [
    {
        name: 'real CLI build embeds the selected bundled dev archive and preserves root dependencies',
        fn() {
            const {root, command, directory, pack, install} = fixture();

            try {
                const old = pack(
                    'old-lint',
                    {name: '@diplodoc/yfmlint', version: '1.0.0'},
                    "module.exports = 'old-lint';\n",
                );
                const sourceSha = 'a'.repeat(40);
                const manifest = {
                    name: '@diplodoc/yfmlint',
                    version: '1.0.0',
                    dependencyTrain: {sourceSha},
                };
                const archive = pack('new-lint', manifest, "module.exports = 'new-lint';\n");
                const stable = pack(
                    'stable',
                    {name: 'candidate-model-stable', version: '1.0.0'},
                    "module.exports = 'stable-old';\n",
                );
                const cli = directory('cli');
                const baseline = {
                    name: '@diplodoc/cli',
                    version: '1.0.0',
                    scripts: {build: 'node build.cjs'},
                    dependencies: {'candidate-model-stable': `file:${stable}`},
                    devDependencies: {'@diplodoc/yfmlint': `file:${old}`},
                };
                write(path.join(cli, 'package.json'), baseline);
                fs.writeFileSync(
                    path.join(cli, 'build.cjs'),
                    "require('node:fs').writeFileSync('built.cjs', 'module.exports = ' + JSON.stringify(require('@diplodoc/yfmlint')) + ';');\n",
                );
                install(cli);
                assert.equal(require(path.join(cli, 'node_modules/@diplodoc/yfmlint')), 'old-lint');

                const selected = {repo: 'yfmlint', sha: sourceSha, manifest};
                const graph = [selected, {repo: 'cli', manifest: baseline}];
                assert.deepEqual(
                    buildOrder(graph, [selected]).map((item) => item.repo),
                    ['yfmlint', 'cli'],
                );
                fs.mkdirSync(path.join(cli, 'dependency-train/payload'), {recursive: true});
                fs.copyFileSync(archive, path.join(cli, 'dependency-train/payload/yfmlint.tgz'));
                const lock = {lockfileVersion: 3, packages: {'': manifest}};
                write(
                    path.join(cli, 'package.json'),
                    withArchives(baseline, new Map([[manifest.name, {repo: 'yfmlint', lock}]])),
                );
                install(cli);
                install(cli, true);
                command(['run', 'build'], cli);

                assert.equal(require(path.join(cli, 'built.cjs')), 'new-lint');
                assert.equal(
                    installed(cli, cli, manifest.name).manifest.dependencyTrain.sourceSha,
                    sourceSha,
                );
                assert.equal(
                    require(path.join(cli, 'node_modules/candidate-model-stable')),
                    'stable-old',
                );
            } finally {
                fs.rmSync(root, {recursive: true, force: true});
            }
        },
    },
    {
        name: 'opt-in archive relocates through npm ci with exact nested source versions',
        fn() {
            const {root, directory, pack, install} = fixture();

            try {
                const leaf = (version) =>
                    pack(
                        `leaf-${version}`,
                        {name: 'candidate-model-leaf', version},
                        `module.exports = '${version}';\n`,
                    );
                const oldLeaf = leaf('1.0.0');
                const newLeaf = leaf('2.0.0');
                const parser = pack(
                    'parser',
                    {
                        name: 'candidate-model-parser',
                        version: '1.0.0',
                        dependencies: {'candidate-model-leaf': `file:${newLeaf}`},
                    },
                    "module.exports = require('candidate-model-leaf');\n",
                );
                const manifest = {
                    name: '@diplodoc/html-extension',
                    version: '1.0.0',
                    dependencies: {'candidate-model-parser': '^1.0.0'},
                    dependencyTrain: {sourceSha: 'b'.repeat(40)},
                };
                const archive = pack(
                    'html',
                    manifest,
                    "module.exports = require('candidate-model-parser');\n",
                );
                const lock = {
                    lockfileVersion: 3,
                    packages: {
                        '': manifest,
                        'node_modules/candidate-model-parser': {
                            version: '1.0.0',
                            resolved: `file:${parser}`,
                            dependencies: {'candidate-model-leaf': '^2.0.0'},
                        },
                        'node_modules/candidate-model-parser/node_modules/candidate-model-leaf': {
                            version: '2.0.0',
                            resolved: `file:${newLeaf}`,
                        },
                    },
                };
                const cli = directory('cli');
                const baseline = {
                    name: '@diplodoc/cli',
                    version: '1.0.0',
                    dependencies: {'candidate-model-leaf': `file:${oldLeaf}`},
                };
                write(path.join(cli, 'package.json'), baseline);
                install(cli);
                fs.mkdirSync(path.join(cli, 'dependency-train/payload'), {recursive: true});
                fs.copyFileSync(
                    archive,
                    path.join(cli, 'dependency-train/payload/html-extension.tgz'),
                );
                write(
                    path.join(cli, 'package.json'),
                    withArchives(
                        baseline,
                        new Map([[manifest.name, {repo: 'html-extension', lock}]]),
                    ),
                );
                install(cli);

                const relocated = directory('relocated');
                for (const file of ['package.json', 'package-lock.json', 'dependency-train']) {
                    fs.cpSync(path.join(cli, file), path.join(relocated, file), {recursive: true});
                }
                fs.rmSync(cli, {recursive: true, force: true});
                install(relocated, true);
                const actual = installed(relocated, relocated, manifest.name);
                const proof = verifyLockedTree(relocated, actual.directory, lock, new Set());

                assert.equal(actual.manifest.dependencyTrain.sourceSha, 'b'.repeat(40));
                assert.equal(require(path.join(actual.directory, 'index.js')), '2.0.0');
                assert.equal(
                    installed(relocated, relocated, 'candidate-model-leaf').manifest.version,
                    '1.0.0',
                );
                assert.deepEqual(proof, [
                    {path: 'node_modules/candidate-model-parser', version: '1.0.0'},
                    {
                        path: 'node_modules/candidate-model-parser/node_modules/candidate-model-leaf',
                        version: '2.0.0',
                    },
                ]);
            } finally {
                fs.rmSync(root, {recursive: true, force: true});
            }
        },
    },
];

module.exports = {tests};
