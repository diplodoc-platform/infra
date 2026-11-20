'use strict';

const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');
const {OWNER, fileAt, read, write} = require('./common');
const {preparedBranch, preparationSection, validatePreparedLock, BOT} = require('./prepare-policy');
const {assess} = require('./plan');

function npm(directory, args, run = execFileSync) {
    run(
        'npm',
        [
            'install',
            '--package-lock-only',
            '--ignore-scripts',
            '--no-workspaces',
            '--no-audit',
            '--no-fund',
            '--cache=./npm-cache',
            '--registry=https://registry.npmjs.org',
            '--userconfig=./empty-user.npmrc',
            '--globalconfig=./empty-global.npmrc',
            ...args,
        ],
        {
            cwd: directory,
            env: {PATH: process.env.PATH},
            timeout: 90_000,
            stdio: ['ignore', 'ignore', 'pipe'],
        },
    );
}

function validateProposal(location, group, manifest, oldLock, newLock, registry, maxRisk) {
    const {repo, baseSha} = location;
    validatePreparedLock(manifest, oldLock, newLock, group.dependency);
    // Use the same review rules that Morning applies to the actual source PR.
    return assess(
        {
            user: {login: BOT},
            state: 'open',
            draft: false,
            base: {ref: 'master', repo: {name: repo}},
            head: {
                ref: preparedBranch(group.dependency),
                repo: {full_name: `${OWNER}/${repo}`},
                sha: baseSha,
            },
        },
        [{filename: 'package-lock.json', status: 'modified'}],
        manifest,
        manifest,
        oldLock,
        newLock,
        registry,
        {maxRisk},
    );
}

function readPolicy() {
    return yaml.load(fs.readFileSync('dependency-policy.yml', 'utf8')).entries;
}

async function canonicalInputs(item, request) {
    return Promise.all([
        fileAt(item.repo, item.baseSha, 'package.json', request),
        fileAt(item.repo, item.baseSha, 'package-lock.json', request),
    ]);
}

function generateLock(manifestText, lockText, dependency, run = execFileSync) {
    const manifest = JSON.parse(manifestText);
    const section = preparationSection(manifest, JSON.parse(lockText), dependency);
    const flags = {
        dependencies: '--save-prod',
        devDependencies: '--save-dev',
        optionalDependencies: '--save-optional',
    };
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-group-lock-'));
    const manifestPath = path.join(directory, 'package.json');

    try {
        fs.writeFileSync(manifestPath, manifestText);
        fs.writeFileSync(path.join(directory, 'package-lock.json'), lockText);
        npm(
            directory,
            [flags[section], '--save-exact', `${dependency.name}@${dependency.version}`],
            run,
        );
        fs.writeFileSync(manifestPath, manifestText);
        npm(directory, [], run);
        assert.equal(fs.readFileSync(manifestPath, 'utf8'), manifestText);
        return read(path.join(directory, 'package-lock.json'));
    } finally {
        fs.rmSync(directory, {recursive: true, force: true});
    }
}

async function prepareLocks(plan, maxRisk, request, generate = generateLock) {
    const {group} = plan;
    assert.ok(group?.missing?.length);
    const inputs = await Promise.all(group.missing.map((item) => canonicalInputs(item, request)));
    const registry = readPolicy();
    return group.missing.map((item, index) => {
        const [manifest, lock] = inputs[index];
        const updated = generate(manifest, lock, group.dependency);
        const assessment = validateProposal(
            item,
            group,
            JSON.parse(manifest),
            JSON.parse(lock),
            updated,
            registry,
            maxRisk,
        );
        return {...item, lock: updated, risk: assessment.maxRisk};
    });
}

if (require.main === module) {
    const plan = read('dependency-refresh-plan.json');
    prepareLocks(plan, process.env.DEPENDENCY_TRAIN_MAX_RISK || 'low')
        .then((locks) => {
            write('dependency-refresh-locks.json', locks);
            const lines = locks.map(({repo, risk}) => `- ${repo}: lockfile validated (${risk})`);
            fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
        })
        .catch((error) => {
            console.error(error.message);
            process.exitCode = 1;
        });
}

module.exports = {generateLock, prepareLocks, readPolicy, canonicalInputs, validateProposal};
