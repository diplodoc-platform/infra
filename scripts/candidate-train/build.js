'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {OWNER, SECTIONS, digest, read, write, validatePlan, buildOrder} = require('./common');
const {assertDependencyDelta, assertSourceBaselines} = require('./dependency-delta');
const {optInExtension} = require('./model');
const {runIntegrationSmoke} = require('./integration-smoke');
const {modeledRuntimeLock} = require('./build-inputs');
const {assembleCliLock, verifyFrozenCli} = require('./cli-lock');
const {sourceOwnedContexts, purePeer, lookup: lookupLocked} = require('./peer-policy');
const {runtimeArtifacts, buildReceipts} = require('./artifacts');

function run(command, args, cwd, capture = false) {
    return execFileSync(command, args, {
        cwd,
        encoding: 'utf8',
        stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
        env: {...process.env, GH_TOKEN: '', GITHUB_TOKEN: '', CI: 'true'},
        timeout: 30 * 60_000,
        maxBuffer: 16 * 1024 * 1024,
    });
}

function scopedLocks(lock, replacements) {
    if (!lock) return {};
    assert.equal(lock.lockfileVersion, 3);
    const lookup = (context, name) => {
        for (;;) {
            const key = `${context ? context + '/' : ''}node_modules/${name}`;
            if (lock.packages[key]) return key;
            if (!context) return null;
            const parent = context.lastIndexOf('/node_modules/');
            context = parent < 0 ? '' : context.slice(0, parent);
        }
    };
    function visit(key, active) {
        const entry = lock.packages[key];
        const result = {};
        const dependencies = {...entry.dependencies, ...entry.optionalDependencies};
        for (const name of Object.keys(dependencies)) {
            if (replacements.has(name)) continue;
            const target = lookup(key, name);
            if (!target && Object.hasOwn(entry.optionalDependencies || {}, name)) continue;
            assert.ok(target, `Missing locked runtime dependency ${name}`);
            const metadata = lock.packages[target];
            assert.ok(!metadata.link && typeof metadata.version === 'string');
            // Local paths are useful only in offline fixtures; source selection
            // rejects file/link dependencies in genuine candidate lockfiles.
            const version = metadata.resolved?.startsWith('file:')
                ? metadata.resolved
                : metadata.version;
            const nested = active.has(target) ? {} : visit(target, new Set([...active, target]));
            result[name] = Object.keys(nested).length ? {'.': version, ...nested} : version;
        }
        return result;
    }
    return visit('', new Set(['']));
}

/** Keep only source exceptions to existing root overrides; the lock pins everything else. */
function lockedOverrides(pins, globals) {
    const names = new Set(
        Object.keys(globals || {}).map(
            (selector) => /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*/.exec(selector)?.[0],
        ),
    );
    const visit = (entries) => {
        const kept = {};
        for (const [name, value] of Object.entries(entries)) {
            if (name === '.') continue;
            if (names.has(name)) kept[name] = value;
            else if (value && typeof value === 'object') {
                const children = visit(value);
                if (Object.keys(children).length) kept[name] = {'.': value['.'], ...children};
            }
        }
        return kept;
    };
    return visit(pins);
}

function withArchives(
    manifest,
    archives,
    spec = (repo) => `file:dependency-train/payload/${repo}.tgz`,
    locked = false,
) {
    const result = structuredClone(manifest);
    result.overrides ||= {};
    for (const [name, {repo, lock}] of archives) {
        const value = spec(repo);
        const profile = optInExtension(name);

        // An opt-in fixture is a deliberate candidate-only root. Source
        // manifests stay frozen; the publisher independently derives this delta.
        const declared = SECTIONS.some((section) => Object.hasOwn(manifest[section] || {}, name));
        if (manifest.name === '@diplodoc/cli' && profile?.repo === repo && !declared) {
            result.dependencies ||= {};
            result.dependencies[name] = value;
        }

        for (const section of SECTIONS.filter((item) => item !== 'peerDependencies')) {
            if (Object.hasOwn(result[section] || {}, name)) result[section][name] = value;
        }
        // Retain existing nested security overrides, changing only this package.
        const prior = result.overrides[name];
        const allPins = scopedLocks(lock, new Set(archives.keys()));
        const pinned = locked ? lockedOverrides(allPins, manifest.overrides) : allPins;
        result.overrides[name] =
            (typeof prior === 'object' && prior !== null) || Object.keys(pinned).length
                ? {...(typeof prior === 'object' ? prior : {}), '.': value, ...pinned}
                : value;
    }
    return result;
}

function installed(boundary, context, name, expectedName = name) {
    for (let current = context; ; current = path.dirname(current)) {
        const file = path.join(current, 'node_modules', name, 'package.json');
        if (path.basename(current) !== 'node_modules' && fs.existsSync(file)) {
            const manifest = read(file);
            assert.equal(manifest.name, expectedName);
            return {directory: path.dirname(file), manifest};
        }
        if (current === boundary) return null;
        assert.ok(
            current.startsWith(boundary + path.sep),
            'Dependency lookup escapes the checkout',
        );
    }
}

function runtimeVersions(
    lock,
    replacementNames,
    includeReplacements = false,
    root = '',
    frozenPeers = false,
) {
    assert.equal(lock.lockfileVersion, 3);
    const resolutions = [];
    const owned = frozenPeers ? sourceOwnedContexts(lock, replacementNames) : null;

    const lookup = (context, name) => {
        for (;;) {
            const key = `${context ? context + '/' : ''}node_modules/${name}`;
            if (lock.packages[key]) return key;
            if (!context) return null;
            const parent = context.lastIndexOf('/node_modules/');
            context = parent < 0 ? '' : context.slice(0, parent);
        }
    };

    function visit(key, chain, active, optional = false, depth = 0) {
        assert.ok(depth <= 100, 'Runtime dependency depth exceeds the proof limit');
        const entry = lock.packages[key];
        assert.ok(entry, `Missing locked runtime context ${key}`);
        const dependencies = {
            ...entry.dependencies,
            ...entry.peerDependencies,
            ...entry.optionalDependencies,
        };

        for (const name of Object.keys(dependencies).sort()) {
            assert.match(name, /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/);
            const replacement = replacementNames.has(name);
            if (replacement && !includeReplacements) continue;

            const isOptional =
                optional ||
                Object.hasOwn(entry.optionalDependencies || {}, name) ||
                (!Object.hasOwn(entry.dependencies || {}, name) &&
                    entry.peerDependenciesMeta?.[name]?.optional === true);
            const target = lookup(key, name);
            if (frozenPeers && purePeer(entry, name) && !owned.has(target)) continue;
            if (!target && isOptional) continue;
            assert.ok(target, `Missing locked runtime dependency ${name}`);

            const metadata = lock.packages[target];
            assert.ok(!metadata.link && typeof metadata.version === 'string');
            const path = `${chain}node_modules/${name}`;
            const optionalPath =
                isOptional || metadata.optional === true || metadata.devOptional === true;

            assert.ok(
                resolutions.length < 20000,
                'Runtime dependency proof exceeds the size limit',
            );
            resolutions.push({
                path,
                version: metadata.version,
                ...(optionalPath ? {optional: true} : {}),
                ...(replacement ? {replacement: name} : {}),
            });

            if (replacement) continue;

            // Check the closing edge too, but never recurse forever through a cycle.
            if (!active.has(target))
                visit(target, path + '/', new Set([...active, target]), optionalPath, depth + 1);
        }
    }

    visit(root, '', new Set([root]));

    return resolutions;
}

function verifyLockedTree(
    boundary,
    directory,
    lock,
    replacementNames,
    root = '',
    frozenPeers = false,
) {
    const proof = [];

    for (const expected of runtimeVersions(lock, replacementNames, false, root, frozenPeers)) {
        const names = expected.path.slice('node_modules/'.length).split('/node_modules/');
        let cursor = directory;
        let actual;
        let expectedContext = root;
        for (const name of names) {
            expectedContext = lookupLocked(lock, expectedContext, name);
            actual = installed(
                boundary,
                cursor,
                name,
                lock.packages[expectedContext]?.name || name,
            );
            if (!actual) break;
            cursor = actual.directory;
        }
        if (!actual && expected.optional) continue;
        assert.ok(actual, `Missing locked dependency ${expected.path}`);
        assert.equal(
            actual.manifest.version,
            expected.version,
            `Locked resolution mismatch: ${expected.path}`,
        );
        proof.push({path: expected.path, version: expected.version});
    }
    return proof;
}

function verifyInstalledPeer(boundary, lock, name, expectedKey, actualKey) {
    const target = path.join(boundary, actualKey);
    const actual = read(path.join(target, 'package.json'));
    assert.equal(actual.name, lock.packages[expectedKey].name || name);
    assert.equal(
        actual.version,
        lock.packages[expectedKey].version,
        `Frozen CLI peer installation mismatch: ${name}`,
    );
    return verifyLockedTree(boundary, target, lock, new Set(), expectedKey);
}

function verifyModeledRuntimeInputs(
    boundary,
    directory,
    node,
    lock,
    archives,
    frozenPeers = false,
) {
    const modeled = modeledRuntimeLock(node, lock);
    if (!modeled) return;
    const replacements = new Set(archives.keys());
    const seen = new Set();

    function verify(context, source) {
        if (seen.has(context)) return;
        assert.ok(seen.size < 2000, 'Modeled runtime archive contexts exceed the limit');
        seen.add(context);
        verifyLockedTree(boundary, context, source, replacements, '', frozenPeers);

        for (const expected of runtimeVersions(source, replacements, true, '', frozenPeers)) {
            if (!expected.replacement) continue;
            const replacement = archives.get(expected.replacement);
            const names = expected.path.slice('node_modules/'.length).split('/node_modules/');
            let cursor = context;
            let actual;

            for (const name of names) {
                actual = installed(boundary, cursor, name);
                if (!actual) break;
                cursor = actual.directory;
            }
            if (!actual && expected.optional) continue;
            assert.equal(
                actual?.manifest.dependencyTrain?.sourceSha,
                replacement.sha,
                `Modeled runtime input fell back to a registry package: ${expected.path}`,
            );
            assert.equal(actual.manifest.version, replacement.lock.packages[''].version);
            verify(actual.directory, replacement.lock);
        }
    }

    verify(directory, modeled);
}

function cloneAt(node, destination) {
    fs.mkdirSync(destination);
    run('git', ['init', '--quiet'], destination);
    run(
        'git',
        [
            'fetch',
            '--quiet',
            '--depth=1',
            '--no-tags',
            `https://github.com/${OWNER}/${node.repo}.git`,
            node.sha,
        ],
        destination,
    );
    run('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], destination);
    assert.equal(run('git', ['rev-parse', 'HEAD'], destination, true).trim(), node.sha);
}

/** Check the common build input and its canonical tree, including dev-only inputs. */
function verifyCohortInput(plan, node, lock, directory) {
    const dependency = plan.cohort?.dependency;
    if (!dependency || !plan.selected.some((item) => item.repo === node.repo)) return;
    assert.equal(
        lock.packages[`node_modules/${dependency.name}`]?.version,
        dependency.version,
        'Canonical cohort input changed',
    );
    verifyLockedTree(
        directory,
        directory,
        {
            ...lock,
            packages: {
                ...lock.packages,
                '': {dependencies: {[dependency.name]: dependency.version}},
            },
        },
        new Set(),
    );
}

function buildCandidate(plan, output) {
    validatePlan(plan);
    assert.ok(plan.selected.length > 0);
    assert.ok(!fs.existsSync(output), 'Output must be a fresh directory');
    fs.mkdirSync(path.join(output, 'dependency-train', 'payload'), {recursive: true});
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'diplodoc-candidate-build-'));
    const archives = new Map();
    const sourceLocks = new Map();
    const proof = {schema: 3, trainId: plan.id, toolSha: plan.toolSha, packages: []};
    const runtimeNames = new Set(runtimeArtifacts(plan).map((item) => item.manifest.name));

    for (const node of buildOrder(plan.graph, plan.selected)) {
        const directory = path.join(scratch, node.repo);
        cloneAt(node, directory);
        const manifest = read(path.join(directory, 'package.json'));
        assert.deepEqual(manifest, node.manifest);
        const lock = read(path.join(directory, 'package-lock.json'));
        assert.equal(lock.lockfileVersion, 3);
        if (node.repo !== 'cli') sourceLocks.set(node.repo, lock);
        else assertSourceBaselines(plan, lock, sourceLocks, true);
        const sourceLockDigest = digest(JSON.stringify(lock));
        const installArchives =
            node.repo === 'cli'
                ? new Map([...archives].filter(([name]) => runtimeNames.has(name)))
                : archives;
        let effective = withArchives(
            manifest,
            installArchives,
            (repo) => `file:${path.join(output, 'dependency-train', 'payload', `${repo}.tgz`)}`,
            node.repo === 'cli',
        );
        if (node.repo === 'cli') {
            effective = withArchives(manifest, installArchives, undefined, true);
            effective.files = [...new Set([...(manifest.files || []), 'dependency-train'])];
            fs.cpSync(
                path.join(output, 'dependency-train'),
                path.join(directory, 'dependency-train'),
                {
                    recursive: true,
                },
            );
        }
        if (node.repo === 'cli' && installArchives.size) {
            const assembled = assembleCliLock(
                lock,
                effective,
                installArchives,
                (repo) =>
                    fs.readFileSync(
                        path.join(output, 'dependency-train', 'payload', `${repo}.tgz`),
                    ),
                true,
            );
            assertDependencyDelta(plan, lock, assembled, sourceLocks, undefined, true);
            write(path.join(directory, 'package-lock.json'), assembled);
        }
        write(path.join(directory, 'package.json'), effective);
        // Source builds keep their established archive installation procedure.
        // Only the final CLI uses the frozen host lock and provider proof.
        run(
            'npm',
            [
                node.repo !== 'cli' && installArchives.size ? 'install' : 'ci',
                '--include=dev',
                '--no-audit',
                '--no-fund',
            ],
            directory,
        );
        if (node.repo === 'cli')
            verifyFrozenCli(lock, directory, installArchives, (context, name, expectedName) =>
                installed(directory, context, name, expectedName),
            );
        verifyCohortInput(plan, node, lock, directory);

        for (const [name, archive] of installArchives) {
            if (!Object.hasOwn({...effective.dependencies, ...effective.devDependencies}, name))
                continue;
            const actual = installed(directory, directory, name);
            assert.equal(
                actual?.manifest.dependencyTrain?.sourceSha,
                archive.sha,
                `Build dependency fallback for ${name}`,
            );
        }
        if (node.repo === 'cli') {
            // npm ci must preserve the assembled lock; compare with the original
            // baseline again before executing the CLI build or tests.
            assertDependencyDelta(
                plan,
                lock,
                read(path.join(directory, 'package-lock.json')),
                sourceLocks,
                undefined,
                true,
            );
            verifyFrozenCli(lock, directory, installArchives, (context, name, expectedName) =>
                installed(directory, context, name, expectedName),
            );
            run('npm', ['run', 'build'], directory);
            run('npm', ['run', 'typecheck', '--if-present'], directory);
            run('npm', ['test', '--', '--update=false'], directory);

            verifyFrozenCli(lock, directory, installArchives, (context, name, expectedName) =>
                installed(directory, context, name, expectedName),
            );

            // External peers use the compatible frozen CLI provider. Verify its
            // exact installed identity and complete dependency tree too.
            const hostPeers = new Map();
            assertDependencyDelta(
                plan,
                lock,
                read(path.join(directory, 'package-lock.json')),
                sourceLocks,
                (name, expectedKey, actualKey, repo, context) => {
                    verifyInstalledPeer(directory, lock, name, expectedKey, actualKey);
                    hostPeers.set(`${repo}:${context}:${name}`, {repo, context, name});
                },
                true,
            );
            proof.hostPeers = [...hostPeers.values()].sort((a, b) =>
                `${a.repo}:${a.context}:${a.name}`.localeCompare(
                    `${b.repo}:${b.context}:${b.name}`,
                ),
            );
            proof.cliBaseLockSha256 = digest(JSON.stringify(lock));

            for (const [name, archive] of installArchives) {
                const actual = installed(directory, directory, name);
                assert.equal(
                    actual?.manifest.dependencyTrain?.sourceSha,
                    archive.sha,
                    `CLI installation fell back to a registry ${name}`,
                );
                const resolutions = verifyLockedTree(
                    directory,
                    actual.directory,
                    archive.lock,
                    new Set(installArchives.keys()),
                    '',
                    true,
                );
                verifyModeledRuntimeInputs(
                    directory,
                    actual.directory,
                    plan.graph.find((item) => item.repo === archive.repo),
                    archive.lock,
                    archives,
                    true,
                );
                proof.packages.push({
                    repo: archive.repo,
                    name,
                    sourceSha: archive.sha,
                    archiveSha256: archive.digest,
                    sourceLockSha256: archive.lockDigest,
                    resolutions,
                });
            }
            proof.builds = buildReceipts(
                plan,
                sourceLocks,
                new Map([...archives.values()].map((item) => [item.repo, item.digest])),
            );
            proof.integrations = runIntegrationSmoke(plan, directory, scratch, run);
            proof.cliBaseSha = node.sha;
            write(path.join(output, 'dependency-train', 'proof.json'), proof);
            fs.copyFileSync(
                path.join(directory, 'package.json'),
                path.join(output, 'package.json'),
            );
            fs.copyFileSync(
                path.join(directory, 'package-lock.json'),
                path.join(output, 'package-lock.json'),
            );
            return proof;
        }

        run('npm', ['run', 'build', '--if-present'], directory);
        verifyCohortInput(plan, node, lock, directory);

        // The CLI root carries exact scoped lock overrides; dependency locks
        // inside published tarballs are not a reliable resolution mechanism.
        effective = {
            ...manifest,
            dependencyTrain: {sourceSha: node.sha, sourceLockSha256: sourceLockDigest},
        };
        write(path.join(directory, 'package.json'), effective);
        const packed = JSON.parse(
            run('npm', ['pack', '--ignore-scripts', '--json'], directory, true),
        );
        assert.equal(packed.length, 1);
        const archivePath = path.join(output, 'dependency-train', 'payload', `${node.repo}.tgz`);
        fs.copyFileSync(path.join(directory, packed[0].filename), archivePath);
        archives.set(manifest.name, {
            repo: node.repo,
            sha: node.sha,
            manifest: node.manifest,
            lock,
            lockDigest: sourceLockDigest,
            digest: digest(fs.readFileSync(archivePath)),
        });
    }
    throw new Error('CLI was not built');
}

if (require.main === module) {
    try {
        buildCandidate(read(process.argv[2]), path.resolve(process.argv[3]));
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = {
    scopedLocks,
    lockedOverrides,
    withArchives,
    installed,
    runtimeVersions,
    verifyLockedTree,
    verifyInstalledPeer,
    verifyModeledRuntimeInputs,
    verifyCohortInput,
    assertDependencyDelta,
    buildCandidate,
};
