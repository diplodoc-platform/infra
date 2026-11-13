const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {planId, digest, write} = require('../../scripts/candidate-train/common');
const {withArchives, verifyLockedTree} = require('../../scripts/candidate-train/build');
const {validatePayload} = require('../../scripts/candidate-train/publish');

const tests = [
    {
        name: 'four unpublished cohort archives survive clean CLI installation and independent payload validation',
        fn() {
            const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cohort-pack-'));
            const output = path.join(root, 'output');
            const cli = path.join(root, 'cli');
            for (const dir of [output, cli])
                fs.mkdirSync(path.join(dir, 'dependency-train/payload'), {recursive: true});
            const npm = (args, cwd) =>
                execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
                    cwd,
                    encoding: 'utf8',
                    shell: process.platform === 'win32',
                    timeout: 120000,
                    env: {
                        ...process.env,
                        npm_config_offline: 'true',
                        npm_config_cache: path.join(root, 'cache'),
                        npm_config_audit: 'false',
                        npm_config_fund: 'false',
                    },
                    stdio: ['ignore', 'pipe', 'pipe'],
                });
            const graph = ['alpha', 'beta', 'gamma', 'delta'].map((repo) => ({
                repo,
                sha: digest(repo).slice(0, 40),
                manifest: {name: `@diplodoc/${repo}`, version: '1.0.0'},
            }));
            const host = {
                repo: 'cli',
                sha: 'a'.repeat(40),
                manifest: {
                    name: '@diplodoc/cli',
                    version: '1.0.0',
                    dependencies: Object.fromEntries(
                        graph.map((node) => [node.manifest.name, '^1.0.0']),
                    ),
                },
            };
            const selected = [...graph]
                .sort((a, b) => a.repo.localeCompare(b.repo))
                .map((node, i) => ({
                    ...node,
                    number: i + 1,
                    baseSha: 'b'.repeat(40),
                    risk: 'low',
                    profile: 'standard',
                }));
            const plan = {
                schema: 2,
                id: '',
                toolSha: 'c'.repeat(40),
                metapackageSha: 'd'.repeat(40),
                readyBy: '2026-11-13T05:00:00.000Z',
                cli: host,
                graph: [...graph, host],
                selected,
                cohort: {requests: selected.map(({repo, number}) => ({repo, number}))},
            };
            plan.id = planId(plan);
            const archives = new Map();
            const locks = new Map();
            const proof = {
                schema: 1,
                trainId: plan.id,
                toolSha: plan.toolSha,
                cliBaseSha: host.sha,
                packages: [],
            };
            const baselineLock = {lockfileVersion: 3, packages: {'': host.manifest}};
            for (const node of graph) {
                const lock = {lockfileVersion: 3, packages: {'': node.manifest}};
                locks.set(node.repo, lock);
                baselineLock.packages[`node_modules/${node.manifest.name}`] = {
                    version: '1.0.0',
                    resolved: `https://registry.npmjs.org/${node.manifest.name}/-/source-1.0.0.tgz`,
                    integrity: 'sha512-canonical',
                };
                const source = path.join(root, node.repo);
                fs.mkdirSync(source);
                write(path.join(source, 'package.json'), {
                    ...node.manifest,
                    main: 'index.js',
                    dependencyTrain: {
                        sourceSha: node.sha,
                        sourceLockSha256: digest(JSON.stringify(lock)),
                    },
                });
                fs.writeFileSync(
                    path.join(source, 'index.js'),
                    `module.exports = '${node.repo}';\n`,
                );
                const packed = JSON.parse(npm(['pack', '--ignore-scripts', '--json'], source));
                const bytes = fs.readFileSync(path.join(source, packed[0].filename));
                for (const dir of [output, cli])
                    fs.writeFileSync(
                        path.join(dir, `dependency-train/payload/${node.repo}.tgz`),
                        bytes,
                    );
                archives.set(node.manifest.name, {...node, lock});
                proof.packages.push({
                    repo: node.repo,
                    name: node.manifest.name,
                    sourceSha: node.sha,
                    sourceLockSha256: digest(JSON.stringify(lock)),
                    archiveSha256: digest(bytes),
                    resolutions: [],
                });
            }
            const manifest = withArchives(host.manifest, archives);
            manifest.files = ['dependency-train'];
            write(path.join(cli, 'package.json'), manifest);
            npm(['install', '--ignore-scripts', '--offline'], cli);
            npm(['ci', '--ignore-scripts', '--offline'], cli);
            for (const node of graph) {
                const actual = path.join(cli, 'node_modules', node.manifest.name);
                const installed = JSON.parse(fs.readFileSync(path.join(actual, 'package.json')));
                assert.equal(installed.dependencyTrain.sourceSha, node.sha);
                assert.equal(require(actual), node.repo);
                verifyLockedTree(cli, actual, locks.get(node.repo), new Set(archives.keys()));
            }
            fs.copyFileSync(path.join(cli, 'package.json'), path.join(output, 'package.json'));
            fs.copyFileSync(
                path.join(cli, 'package-lock.json'),
                path.join(output, 'package-lock.json'),
            );
            write(path.join(output, 'dependency-train/proof.json'), proof);
            assert.equal(validatePayload(plan, output, locks, baselineLock).length, 7);
            fs.appendFileSync(path.join(output, 'dependency-train/payload/alpha.tgz'), 'corrupt');
            assert.throws(() => validatePayload(plan, output, locks, baselineLock));
            fs.rmSync(root, {recursive: true, force: true});
        },
    },
];

module.exports = {tests};
