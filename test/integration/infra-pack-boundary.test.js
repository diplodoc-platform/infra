const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const yaml = require('js-yaml');

const root = path.join(__dirname, '../..');
const tests = [
    {
        name: 'npm package excludes central-only automation but retains the public infra CLI helper closure',
        fn() {
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-pack-boundary-'));
            try {
                const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
                const output = execFileSync(
                    npm,
                    ['pack', '--dry-run', '--ignore-scripts', '--json', '--cache', directory],
                    {
                        cwd: root,
                        encoding: 'utf8',
                        shell: process.platform === 'win32',
                        stdio: 'pipe',
                        timeout: 120000,
                        env: {...process.env, npm_config_offline: 'true'},
                    },
                );
                const files = new Set(JSON.parse(output)[0].files.map((file) => file.path));
                assert.ok(![...files].some((file) => file.startsWith('scripts/candidate-train/')));
                assert.ok(![...files].some((file) => file.startsWith('scripts/workflows/')));
                for (const file of [
                    'dependency-health.js',
                    'dependency-summary.js',
                    'dependency-assign.js',
                    'auto-merge.js',
                    'export-pr-inventory.js',
                ]) {
                    assert.ok(
                        files.has('scripts/' + file),
                        `Public infra subcommand helper: ${file}`,
                    );
                }

                const visited = new Set();
                const visit = (file) => {
                    const relative = path.relative(root, file).replace(/\\/g, '/');
                    if (visited.has(relative)) return;
                    visited.add(relative);
                    assert.ok(files.has(relative), `Missing public helper: ${relative}`);
                    if (!file.endsWith('.js')) return;
                    const source = fs.readFileSync(file, 'utf8');
                    for (const [, specifier] of source.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
                        const target = path.resolve(path.dirname(file), specifier);
                        const resolved = [
                            target,
                            target + '.js',
                            target + '.json',
                            path.join(target, 'index.js'),
                        ].find((entry) => fs.existsSync(entry) && fs.statSync(entry).isFile());
                        assert.ok(resolved, `Unresolved local public helper: ${specifier}`);
                        visit(resolved);
                    }
                };
                visit(path.join(root, 'bin/infra.js'));
                // Subcommands are spawned rather than required; retain their transitive helpers too.
                const cli = fs.readFileSync(path.join(root, 'bin/infra.js'), 'utf8');
                for (const [, file] of cli.matchAll(/['"](scripts\/[^'"]+\.js)['"]/g)) {
                    visit(path.join(root, file));
                }
                for (const file of [
                    'generate-dependency-policy.js',
                    'generate-dependabot-ignores.js',
                ]) {
                    visit(path.join(root, 'scripts', file));
                }
            } finally {
                fs.rmSync(directory, {recursive: true, force: true});
            }
        },
    },
    {
        name: 'central candidate workflow executes its own exact checked-out source, not the npm package',
        fn() {
            const workflow = yaml.load(
                fs.readFileSync(
                    path.join(root, '.github/workflows/dependency-candidate-train.yml'),
                    'utf8',
                ),
            );
            for (const [jobName, job] of Object.entries(workflow.jobs)) {
                const index = job.steps.findIndex((step) =>
                    step.run?.includes('node scripts/candidate-train/'),
                );
                assert.ok(index >= 0, `${jobName} must execute a candidate helper`);
                const checkout = job.steps
                    .slice(0, index)
                    .find((step) => step.uses?.startsWith('actions/checkout@'));
                assert.ok(checkout, `${jobName} must check out its own tooling`);
                assert.equal(checkout.with.ref, '${{ github.sha }}');
                assert.equal(checkout.with['persist-credentials'], false);
            }
        },
    },
];

module.exports = {tests};
