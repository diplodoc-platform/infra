const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {createHash} = require('node:crypto');

const {write} = require('../../scripts/candidate-train/common');
const {withArchives, installed, verifyLockedTree} = require('../../scripts/candidate-train/build');

const tests = [
    {
        name: 'real npm packing and npm ci preserve exact versions along nested runtime chains',
        fn() {
            const root = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-nested-pack-'));
            const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
            const command = (args, cwd) =>
                execFileSync(npm, args, {
                    cwd,
                    encoding: 'utf8',
                    shell: process.platform === 'win32',
                    timeout: 120000,
                    env: {
                        ...process.env,
                        npm_config_cache: path.join(root, 'cache'),
                        npm_config_offline: 'true',
                        npm_config_audit: 'false',
                        npm_config_fund: 'false',
                    },
                    stdio: ['ignore', 'pipe', 'pipe'],
                });
            const pack = (name, version, dependencies, code) => {
                const directory = path.join(root, name + '-' + version);
                fs.mkdirSync(directory);
                write(path.join(directory, 'package.json'), {
                    name,
                    version,
                    dependencies,
                    main: 'index.js',
                });
                fs.writeFileSync(path.join(directory, 'index.js'), code);
                const result = JSON.parse(
                    command(['pack', '--ignore-scripts', '--json'], directory),
                );
                return 'file:' + path.join(directory, result[0].filename);
            };

            const oldLeaf = pack('candidate-entities', '4.5.0', {}, "module.exports = '4.5.0';");
            const leaf = pack('candidate-entities', '7.0.1', {}, "module.exports = '7.0.1';");
            const parser = pack(
                'candidate-parser',
                '10.1.0',
                {'candidate-entities': leaf},
                "module.exports = require('candidate-entities');",
            );
            const parent = pack(
                'candidate-parent',
                '1.2.0',
                {'candidate-parser': parser},
                "module.exports = require('candidate-parser');",
            );
            const cli = path.join(root, 'cli');
            fs.mkdirSync(cli);
            write(path.join(cli, 'package.json'), {
                name: 'candidate-cli',
                version: '1.0.0',
                dependencies: {'candidate-parent': parent, 'candidate-entities': oldLeaf},
            });
            command(['install', '--ignore-scripts', '--offline'], cli);
            command(['ci', '--ignore-scripts', '--offline'], cli);

            // The source lock can hoist the leaf next to its real parent parser.
            const lock = {
                lockfileVersion: 3,
                packages: {
                    '': {
                        dependencies: {
                            'candidate-parent': '^1.2.0',
                            'candidate-entities': '^4.5.0',
                        },
                    },
                    'node_modules/candidate-parent': {
                        version: '1.2.0',
                        dependencies: {'candidate-parser': '^10.1.0'},
                    },
                    'node_modules/candidate-parent/node_modules/candidate-parser': {
                        version: '10.1.0',
                        dependencies: {'candidate-entities': '^7.0.1'},
                    },
                    'node_modules/candidate-parent/node_modules/candidate-entities': {
                        version: '7.0.1',
                    },
                    'node_modules/candidate-entities': {version: '4.5.0'},
                },
            };
            const proof = verifyLockedTree(cli, cli, lock, new Set());
            assert.ok(
                proof.some(
                    (item) =>
                        item.path ===
                            'node_modules/candidate-parent/node_modules/candidate-parser/node_modules/candidate-entities' &&
                        item.version === '7.0.1',
                ),
            );
            assert.equal(require(path.join(cli, 'node_modules/candidate-parent')), '7.0.1');
            assert.equal(require(path.join(cli, 'node_modules/candidate-entities')), '4.5.0');

            const actualParent = installed(cli, cli, 'candidate-parent');
            const actualParser = installed(cli, actualParent.directory, 'candidate-parser');
            const actualLeaf = installed(cli, actualParser.directory, 'candidate-entities');
            write(path.join(actualLeaf.directory, 'package.json'), {
                name: 'candidate-entities',
                version: '4.5.0',
            });
            assert.throws(
                () => verifyLockedTree(cli, cli, lock, new Set()),
                /Locked resolution mismatch/,
            );
        },
    },
    {
        name: 'temporary tarball preserves lock-only versions through relocated CLI npm ci',
        fn() {
            const root = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-pack-proof-'));
            const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
            const command = (args, cwd) =>
                execFileSync(npm, args, {
                    cwd,
                    encoding: 'utf8',
                    shell: process.platform === 'win32',
                    timeout: 120_000,
                    env: {
                        ...process.env,
                        npm_config_cache: path.join(root, 'cache'),
                        npm_config_offline: 'true',
                        npm_config_audit: 'false',
                        npm_config_fund: 'false',
                    },
                    stdio: ['ignore', 'pipe', 'pipe'],
                });
            const pack = (directory) => {
                const result = JSON.parse(
                    command(['pack', '--ignore-scripts', '--json'], directory),
                );
                return path.join(directory, result[0].filename);
            };
            const marker = (version) => {
                const directory = path.join(root, `marker-${version}`);
                fs.mkdirSync(directory);
                write(path.join(directory, 'package.json'), {
                    name: 'candidate-marker',
                    version,
                    main: 'index.js',
                });
                fs.writeFileSync(
                    path.join(directory, 'index.js'),
                    `module.exports = ${JSON.stringify(version)};\n`,
                );
                return pack(directory);
            };
            const originalMarker = marker('1.0.0');
            const newMarker = marker('1.1.0');
            const candidate = path.join(root, 'utils');
            fs.mkdirSync(candidate);
            const manifest = {
                name: '@diplodoc/utils',
                version: '1.0.0',
                main: 'index.js',
                files: ['index.js'],
                dependencies: {'candidate-marker': '^1.0.0'},
                dependencyTrain: {sourceSha: 'a'.repeat(40)},
            };
            write(path.join(candidate, 'package.json'), manifest);
            fs.writeFileSync(
                path.join(candidate, 'index.js'),
                "module.exports = require('candidate-marker');\n",
            );
            const lock = {
                name: manifest.name,
                version: manifest.version,
                lockfileVersion: 3,
                packages: {
                    '': manifest,
                    'node_modules/candidate-marker': {
                        version: '1.1.0',
                        resolved: `file:${newMarker}`,
                        integrity: `sha512-${createHash('sha512').update(fs.readFileSync(newMarker)).digest('base64')}`,
                    },
                },
            };
            const candidateArchive = pack(candidate);
            const cli = path.join(root, 'cli');
            fs.mkdirSync(path.join(cli, 'dependency-train/payload'), {recursive: true});
            fs.copyFileSync(candidateArchive, path.join(cli, 'dependency-train/payload/utils.tgz'));
            const cliManifest = withArchives(
                {
                    name: 'candidate-cli-fixture',
                    version: '1.0.0',
                    dependencies: {
                        '@diplodoc/utils': '^1.0.0',
                        'candidate-marker': `file:${originalMarker}`,
                    },
                },
                new Map([['@diplodoc/utils', {repo: 'utils', lock}]]),
            );
            write(path.join(cli, 'package.json'), cliManifest);
            command(['install', '--ignore-scripts', '--offline'], cli);
            const relocated = path.join(root, 'relocated');
            fs.mkdirSync(relocated);
            for (const file of ['package.json', 'package-lock.json', 'dependency-train']) {
                fs.cpSync(path.join(cli, file), path.join(relocated, file), {recursive: true});
            }
            command(['ci', '--ignore-scripts', '--offline'], relocated);
            const actual = installed(relocated, relocated, '@diplodoc/utils');
            assert.equal(actual.manifest.dependencyTrain.sourceSha, 'a'.repeat(40));
            assert.equal(
                installed(relocated, relocated, 'candidate-marker').manifest.version,
                '1.0.0',
            );
            assert.equal(verifyLockedTree(relocated, actual.directory, lock, new Set()).length, 1);
            assert.equal(require(path.join(actual.directory, 'index.js')), '1.1.0');

            // The downstream builder installs CLI as a workspace. Its root overrides
            // take precedence: a standalone-only proof must never certify this path.
            const workspace = path.join(root, 'workspace');
            const workspaceCli = path.join(workspace, 'extensions/cli');
            fs.mkdirSync(workspaceCli, {recursive: true});
            fs.cpSync(
                path.join(cli, 'dependency-train'),
                path.join(workspaceCli, 'dependency-train'),
                {recursive: true},
            );
            write(path.join(workspaceCli, 'package.json'), {...cliManifest, name: '@diplodoc/cli'});
            const workspaceManifest = {
                name: 'internal-builder-fixture',
                version: '1.0.0',
                private: true,
                workspaces: ['extensions/*'],
                dependencies: {'@diplodoc/cli': '*', 'candidate-marker': `file:${originalMarker}`},
                overrides: {'candidate-marker': `file:${originalMarker}`},
            };
            write(path.join(workspace, 'package.json'), workspaceManifest);
            command(['install', '--ignore-scripts', '--offline'], workspace);
            const wrong = installed(workspace, workspaceCli, '@diplodoc/utils');
            assert.throws(
                () => verifyLockedTree(workspace, wrong.directory, lock, new Set()),
                'Workspace install must expose ignored CLI overrides',
            );

            const freshWorkspace = path.join(root, 'fresh-workspace');
            const freshCli = path.join(freshWorkspace, 'extensions/cli');
            fs.mkdirSync(freshCli, {recursive: true});
            fs.cpSync(path.join(cli, 'dependency-train'), path.join(freshCli, 'dependency-train'), {
                recursive: true,
            });
            write(path.join(freshCli, 'package.json'), {...cliManifest, name: '@diplodoc/cli'});
            const fixed = withArchives(
                workspaceManifest,
                new Map([['@diplodoc/utils', {repo: 'utils', lock}]]),
                (repo) => `file:${path.join(freshCli, 'dependency-train/payload', `${repo}.tgz`)}`,
            );
            write(path.join(freshWorkspace, 'package.json'), fixed);
            command(['install', '--ignore-scripts', '--offline'], freshWorkspace);
            command(['ci', '--ignore-scripts', '--offline'], freshWorkspace);
            const correct = installed(freshWorkspace, freshCli, '@diplodoc/utils');
            assert.equal(
                verifyLockedTree(freshWorkspace, correct.directory, lock, new Set()).length,
                1,
            );
            assert.equal(
                installed(freshWorkspace, freshWorkspace, 'candidate-marker').manifest.version,
                '1.0.0',
            );
        },
    },
];

module.exports = {tests};
