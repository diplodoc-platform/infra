const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {createHash} = require('node:crypto');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {assembleCliLock, verifyFrozenCli} = require('../../scripts/candidate-train/cli-lock');
const {withArchives, installed, verifyLockedTree} = require('../../scripts/candidate-train/build');
const {assertDependencyDelta} = require('../../scripts/candidate-train/dependency-delta');

const tests = [
    {
        name: 'archive installation preserves frozen CLI peer consumers and their transitive trees',
        async fn() {
            const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-lock-'));
            const packages = new Map();
            let latest = '1.0.0';
            let registry;
            const server = http.createServer((req, res) => {
                const name = req.url.slice(1);
                if (packages.has(name)) {
                    res.setHeader('Content-Type', 'application/octet-stream');
                    return res.end(packages.get(name).bytes);
                }
                const versions = [...packages.values()].filter(
                    (item) =>
                        item.manifest.name === name &&
                        (name !== 'common' ||
                            item.manifest.version === '1.0.0' ||
                            latest === '1.1.0'),
                );
                res.setHeader('Content-Type', 'application/json');
                if (!versions.length) {
                    res.statusCode = 404;
                    return res.end('{}');
                }
                res.end(
                    JSON.stringify({
                        name,
                        'dist-tags': {latest: name === 'common' ? latest : '1.0.0'},
                        versions: Object.fromEntries(
                            versions.map((item) => [
                                item.manifest.version,
                                {
                                    ...item.manifest,
                                    dist: {
                                        tarball: registry + item.filename,
                                        integrity: item.integrity,
                                    },
                                },
                            ]),
                        ),
                    }),
                );
            });
            const npm = async (args, cwd) => {
                const result = await promisify(execFile)(
                    process.platform === 'win32' ? 'npm.cmd' : 'npm',
                    args,
                    {
                        cwd,
                        encoding: 'utf8',
                        shell: process.platform === 'win32',
                        timeout: 120000,
                        env: {
                            ...process.env,
                            GH_TOKEN: '',
                            GITHUB_TOKEN: '',
                            npm_config_registry: registry || 'http://127.0.0.1:1/',
                            npm_config_cache: path.join(root, 'cache'),
                            npm_config_userconfig: path.join(root, 'user.npmrc'),
                            npm_config_globalconfig: path.join(root, 'global.npmrc'),
                            npm_config_audit: 'false',
                            npm_config_fund: 'false',
                            npm_config_prefer_online: 'true',
                        },
                    },
                );
                return result.stdout;
            };
            const write = (dir, name, value) =>
                fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
            const read = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name)));
            try {
                for (const manifest of [
                    {name: 'common', version: '1.0.0'},
                    {name: 'common', version: '1.1.0'},
                    {name: 'carrier', version: '1.0.0', dependencies: {common: '^1.0.0'}},
                    {name: 'tool', version: '1.0.0', peerDependencies: {carrier: '^1.0.0'}},
                    {name: '@diplodoc/leaf', version: '1.0.0', dependencies: {carrier: '^1.0.0'}},
                ]) {
                    const dir = path.join(root, manifest.name.replace('/', '-') + manifest.version);
                    fs.mkdirSync(dir);
                    write(
                        dir,
                        'package.json',
                        manifest.name === '@diplodoc/leaf'
                            ? {
                                  ...manifest,
                                  dependencyTrain: {sourceSha: 'a'.repeat(40)},
                              }
                            : manifest,
                    );
                    fs.writeFileSync(
                        path.join(dir, 'index.js'),
                        `module.exports = ${JSON.stringify(manifest.version)};`,
                    );
                    const packed = JSON.parse(
                        await npm(['pack', '--ignore-scripts', '--json'], dir),
                    )[0];
                    const bytes = fs.readFileSync(path.join(dir, packed.filename));
                    packages.set(packed.filename, {
                        manifest,
                        filename: packed.filename,
                        bytes,
                        integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
                    });
                }
                await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
                registry = `http://127.0.0.1:${server.address().port}/`;
                const tool = [...packages.values()].find((item) => item.manifest.name === 'tool');
                const leaf = [...packages.values()].find(
                    (item) => item.manifest.name === '@diplodoc/leaf',
                );
                for (const item of [tool, leaf])
                    fs.writeFileSync(path.join(root, item.filename), item.bytes);
                const cli = path.join(root, 'cli');
                fs.mkdirSync(cli);
                const manifest = {
                    name: '@diplodoc/cli',
                    version: '1.0.0',
                    dependencies: {
                        tool: `file:${path.join(root, tool.filename)}`,
                        [leaf.manifest.name]: `file:${path.join(root, leaf.filename)}`,
                    },
                };
                write(cli, 'package.json', manifest);
                await npm(['install', '--ignore-scripts'], cli);
                const baseline = read(cli, 'package-lock.json');
                assert.equal(baseline.packages['node_modules/common'].version, '1.0.0');
                latest = '1.1.0';
                const metadata = (name, version) => {
                    const item = [...packages.values()].find(
                        (item) => item.manifest.name === name && item.manifest.version === version,
                    );
                    return {
                        version,
                        resolved: registry + item.filename,
                        integrity: item.integrity,
                        ...(item.manifest.dependencies
                            ? {dependencies: item.manifest.dependencies}
                            : {}),
                    };
                };
                const lock = {
                    lockfileVersion: 3,
                    packages: {
                        '': leaf.manifest,
                        'node_modules/carrier': metadata('carrier', '1.0.0'),
                        'node_modules/common': metadata('common', '1.1.0'),
                    },
                };
                const node = {repo: 'leaf', sha: 'a'.repeat(40), manifest: leaf.manifest, lock};
                const archives = new Map([[leaf.manifest.name, node]]);
                const candidate = withArchives(manifest, archives);
                const payload = path.join(cli, 'dependency-train/payload');
                fs.mkdirSync(payload, {recursive: true});
                fs.writeFileSync(path.join(payload, 'leaf.tgz'), leaf.bytes);

                const assembled = assembleCliLock(baseline, candidate, archives, () => leaf.bytes);
                const host = {repo: 'cli', sha: 'b'.repeat(40), manifest};
                const plan = {
                    graph: [{repo: node.repo, sha: node.sha, manifest: node.manifest}, host],
                    selected: [node],
                };
                const locks = new Map([['leaf', lock]]);

                assertDependencyDelta(plan, baseline, assembled, locks);
                assert.deepEqual(
                    assembled.packages['node_modules/common'],
                    baseline.packages['node_modules/common'],
                );
                write(cli, 'package.json', candidate);
                write(cli, 'package-lock.json', assembled);
                await npm(['ci', '--ignore-scripts'], cli);
                assert.deepEqual(read(cli, 'package-lock.json'), assembled);
                assert.equal(installed(cli, cli, 'common').manifest.version, '1.0.0');
                const verifyActual = () =>
                    verifyFrozenCli(baseline, cli, archives, (context, name) =>
                        installed(cli, context, name),
                    );
                verifyActual();
                const actual = installed(cli, cli, leaf.manifest.name);
                verifyLockedTree(cli, actual.directory, lock, new Set(archives.keys()));
                const common = installed(cli, cli, 'common');
                write(common.directory, 'package.json', {...common.manifest, version: '1.1.0'});
                assert.throws(verifyActual, /Frozen installed CLI dependency changed/);
                const tampered = structuredClone(assembled);
                tampered.packages['node_modules/common'].version = '1.1.0';
                assert.throws(() => assertDependencyDelta(plan, baseline, tampered, locks));
            } finally {
                await new Promise((resolve) => server.close(resolve));
                fs.rmSync(root, {recursive: true, force: true});
            }
        },
    },
];
module.exports = {tests};
