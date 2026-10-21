'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {OWNER, SECTIONS, digest, read, write, validatePlan, buildOrder} = require('./common');

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

function withArchives(
    manifest,
    archives,
    spec = (repo) => `file:dependency-train/payload/${repo}.tgz`,
) {
    const result = structuredClone(manifest);
    result.overrides ||= {};
    for (const [name, {repo, lock}] of archives) {
        const value = spec(repo);
        for (const section of SECTIONS.filter((item) => item !== 'peerDependencies')) {
            if (Object.hasOwn(result[section] || {}, name)) result[section][name] = value;
        }
        // Retain existing nested security overrides, changing only this package.
        const prior = result.overrides[name];
        const pinned = scopedLocks(lock, new Set(archives.keys()));
        result.overrides[name] =
            (typeof prior === 'object' && prior !== null) || Object.keys(pinned).length
                ? {...(typeof prior === 'object' ? prior : {}), '.': value, ...pinned}
                : value;
    }
    return result;
}

function installed(boundary, context, name) {
    for (let current = context; ; current = path.dirname(current)) {
        const file = path.join(current, 'node_modules', name, 'package.json');
        if (path.basename(current) !== 'node_modules' && fs.existsSync(file)) {
            const manifest = read(file);
            assert.equal(manifest.name, name);
            return {directory: path.dirname(file), manifest};
        }
        if (current === boundary) return null;
        assert.ok(
            current.startsWith(boundary + path.sep),
            'Dependency lookup escapes the checkout',
        );
    }
}

function runtimeVersions(lock, replacementNames) {
    assert.equal(lock.lockfileVersion, 3);
    const resolutions = [];

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
            assert.match(name, /^(?:@[a-z0-9][a-z0-9-]*\/)?[a-z0-9][a-z0-9._-]*$/);
            if (replacementNames.has(name)) continue;

            const isOptional =
                optional ||
                Object.hasOwn(entry.optionalDependencies || {}, name) ||
                entry.peerDependenciesMeta?.[name]?.optional === true;
            const target = lookup(key, name);
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
            });

            // Check the closing edge too, but never recurse forever through a cycle.
            if (!active.has(target))
                visit(target, path + '/', new Set([...active, target]), optionalPath, depth + 1);
        }
    }

    visit('', '', new Set(['']));

    return resolutions;
}

function verifyLockedTree(boundary, directory, lock, replacementNames) {
    const proof = [];

    for (const expected of runtimeVersions(lock, replacementNames)) {
        const names = expected.path.slice('node_modules/'.length).split('/node_modules/');
        let cursor = directory;
        let actual;
        for (const name of names) {
            actual = installed(boundary, cursor, name);
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

function buildCandidate(plan, output) {
    validatePlan(plan);
    assert.ok(plan.selected.length > 0);
    assert.ok(!fs.existsSync(output), 'Output must be a fresh directory');
    fs.mkdirSync(path.join(output, 'dependency-train', 'payload'), {recursive: true});
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'diplodoc-candidate-build-'));
    const archives = new Map();
    const proof = {schema: 1, trainId: plan.id, toolSha: plan.toolSha, packages: []};

    for (const node of buildOrder(plan.graph, plan.selected)) {
        const directory = path.join(scratch, node.repo);
        cloneAt(node, directory);
        const manifest = read(path.join(directory, 'package.json'));
        assert.deepEqual(manifest, node.manifest);
        const lock = read(path.join(directory, 'package-lock.json'));
        assert.equal(lock.lockfileVersion, 3);
        const sourceLockDigest = digest(JSON.stringify(lock));
        let effective = withArchives(
            manifest,
            archives,
            (repo) => `file:${path.join(output, 'dependency-train', 'payload', `${repo}.tgz`)}`,
        );
        write(path.join(directory, 'package.json'), effective);
        if (archives.size) {
            run('npm', ['install', '--include=dev', '--no-audit', '--no-fund'], directory);
        } else {
            run('npm', ['ci', '--include=dev', '--no-audit', '--no-fund'], directory);
        }

        for (const [name, archive] of archives) {
            if (!Object.hasOwn({...effective.dependencies, ...effective.devDependencies}, name))
                continue;
            const actual = installed(directory, directory, name);
            assert.equal(
                actual?.manifest.dependencyTrain?.sourceSha,
                archive.sha,
                `Build dependency fallback for ${name}`,
            );
        }
        run('npm', ['run', 'build', '--if-present'], directory);

        if (node.repo === 'cli') {
            run('npm', ['run', 'typecheck', '--if-present'], directory);
            run('npm', ['test', '--', '--update=false'], directory);
            const relative = withArchives(manifest, archives);
            relative.files = [...new Set([...(manifest.files || []), 'dependency-train'])];
            write(path.join(directory, 'package.json'), relative);
            fs.cpSync(
                path.join(output, 'dependency-train'),
                path.join(directory, 'dependency-train'),
                {recursive: true},
            );
            run(
                'npm',
                ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
                directory,
            );
            // Reinstall with the actual relocatable specs, not the build-only paths.
            run('npm', ['ci', '--include=dev', '--no-audit', '--no-fund'], directory);
            run('npm', ['run', 'build'], directory);

            for (const [name, archive] of archives) {
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
                    new Set(archives.keys()),
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
            const docs = path.join(scratch, 'input');
            fs.mkdirSync(docs);
            fs.writeFileSync(path.join(docs, 'index.md'), '# Candidate smoke\n\nVerified build.\n');
            run(
                'node',
                ['build/index.js', 'build', '-i', docs, '-o', path.join(scratch, 'html')],
                directory,
            );
            run(
                'node',
                [
                    'build/index.js',
                    'build',
                    '-i',
                    docs,
                    '-o',
                    path.join(scratch, 'md'),
                    '--output-format',
                    'md',
                ],
                directory,
            );
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
    withArchives,
    installed,
    runtimeVersions,
    verifyLockedTree,
    buildCandidate,
};
