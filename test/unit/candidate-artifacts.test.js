const assert = require('node:assert/strict');
const {runtimeArtifacts, buildReceipts} = require('../../scripts/candidate-train/artifacts');
const node = (repo, dependencies = {}, devDependencies = {}) => ({
    repo,
    sha: 'a'.repeat(40),
    manifest: {name: `@diplodoc/${repo}`, version: '1.0.0', dependencies, devDependencies},
});
module.exports.tests = [
    {
        name: 'build-only components receipt binds client input without claiming a CLI runtime installation',
        fn() {
            const components = node('components', {}, {'@types/react': '^19.3.0'});
            const client = node('client', {}, {'@diplodoc/components': '*'});
            const cli = node('cli', {'@diplodoc/client': '*'});
            const plan = {
                graph: [components, client, cli],
                selected: [components],
                cli,
                cohort: {dependency: {name: '@types/react', version: '19.3.0'}},
            };
            const locks = new Map(
                [components, client].map((n) => [
                    n.repo,
                    {
                        lockfileVersion: 3,
                        packages: {
                            '': n.manifest,
                            'node_modules/@types/react': {version: '19.3.0'},
                        },
                    },
                ]),
            );
            const hashes = new Map([
                ['components', 'c'.repeat(64)],
                ['client', 'd'.repeat(64)],
            ]);
            assert.deepEqual(
                runtimeArtifacts(plan).map((n) => n.repo),
                ['client'],
            );
            const receipts = buildReceipts(plan, locks, hashes);
            assert.deepEqual(receipts[0].cohortInput, {name: '@types/react', version: '19.3.0'});
            assert.deepEqual(receipts[1].inputs, [
                {
                    repo: 'components',
                    sourceSha: components.sha,
                    archiveSha256: hashes.get('components'),
                },
            ]);
            assert.equal(receipts[0].scope, 'package-build');
            locks.get('components').packages['node_modules/@types/react'].version = '19.2.0';
            assert.throws(() => buildReceipts(plan, locks, hashes));
        },
    },
];
