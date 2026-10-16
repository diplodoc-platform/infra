const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {runInNewContext} = require('node:vm');
const yaml = require('js-yaml');

const tests = [];
const load = (name) =>
    yaml.load(readFileSync(join(__dirname, '../../scaffolding/.github/workflows', name), 'utf8'));
const coverage = load('coverage.yml');
const lock = load('package-lock.yml');
const sonar = coverage.jobs.coverage.steps.find((step) => step.name === 'SonarCloud Scan');
const verify = lock.jobs['verify-dependabot-lock'];
const writer = lock.jobs['update-package-lock'];

function evaluate(expression, githubContext) {
    return runInNewContext(
        expression.replaceAll('steps.coverage-run', 'steps["coverage-run"]'),
        githubContext,
    );
}

function context(author, actor = author, fork = false, event = 'pull_request') {
    return {
        github: {
            actor,
            repository: 'owner/repo',
            event_name: event,
            event: {
                pull_request: {
                    user: {login: author},
                    head: {repo: {full_name: fork ? 'other/repo' : 'owner/repo'}},
                },
            },
        },
        steps: {'coverage-run': {outputs: {ran: 'true'}}},
        success: () => true,
    };
}

for (const [name, githubContext, expected] of [
    ['Dependabot', context('dependabot[bot]'), false],
    ['human rerun of Dependabot', context('dependabot[bot]', 'maintainer'), false],
    ['fork PR', context('contributor', 'contributor', true), false],
    ['same-repo human PR', context('maintainer'), true],
    ['human PR rerun by Dependabot', context('maintainer', 'dependabot[bot]'), false],
]) {
    tests.push({
        name: `secret steps exclude ${name} as appropriate`,
        fn: () => {
            assert.equal(evaluate(sonar.if, githubContext), expected);
            assert.equal(evaluate(writer.if, githubContext), expected);
            assert.equal(
                evaluate(verify.if, githubContext),
                githubContext.github.event.pull_request.user.login === 'dependabot[bot]',
            );
        },
    });
}

tests.push({
    name: 'Dependabot lock validation installs only the committed lock without scripts or writer credentials',
    fn: () => {
        assert.deepEqual(lock.permissions, {contents: 'read'});
        const checkout = verify.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
        assert.equal(checkout.with['persist-credentials'], false);
        assert.equal(checkout.with.token, undefined);
        assert.ok(
            verify.steps.some((step) => step.run === 'npm ci --no-workspaces --ignore-scripts'),
        );
        assert.ok(!JSON.stringify(verify).includes('secrets.'));
        assert.deepEqual(writer.permissions, {contents: 'write'});
    },
});

tests.push({
    name: 'Coverage tests and artifact remain unconditional for bot and fork PRs',
    fn: () => {
        assert.deepEqual(coverage.permissions, {contents: 'read'});
        assert.equal(coverage.jobs.coverage.if, undefined);
        const run = coverage.jobs.coverage.steps.find((step) => step.id === 'coverage-run');
        assert.equal(run.if, undefined);
        assert.ok(run.run.includes('npm run test:coverage'));
        const upload = coverage.jobs.coverage.steps.find(
            (step) => step.name === 'Upload coverage artifact',
        );
        assert.equal(evaluate(upload.if, context('dependabot[bot]')), true);
        assert.equal(sonar.env.SONAR_TOKEN, '${{ secrets.SONAR_TOKEN }}');
    },
});

tests.push({
    name: 'secretless explanation never claims that Sonar ran',
    fn: () => {
        const explain = coverage.jobs.coverage.steps.find(
            (step) => step.name === 'Explain secretless coverage',
        );
        assert.equal(evaluate(explain.if, context('dependabot[bot]', 'maintainer')), true);
        assert.equal(evaluate(explain.if, context('maintainer')), false);
        assert.ok(explain.run.includes('Sonar upload is not run'));
    },
});

tests.push({
    name: 'The existing required lockfile check fails on failed, cancelled or skipped validation',
    fn: () => {
        const gate = lock.jobs['package-lock-result'];
        assert.equal(gate.name, 'Update package-lock.json');
        assert.deepEqual(gate.needs, ['verify-dependabot-lock', 'update-package-lock']);
        assert.ok(gate.if.startsWith('always()'));
        assert.ok(gate.steps[0].env.LOCK_RESULT.includes('github.event.pull_request.user.login'));
        assert.ok(gate.steps[0].env.LOCK_RESULT.includes('needs.verify-dependabot-lock.result'));
        assert.ok(gate.steps[0].run.includes('test "$LOCK_RESULT" = success'));
        // The result job runs on Ubuntu. Windows hosts still verify the shell contract above.
        if (process.platform === 'win32') return;
        for (const result of ['success', 'failure', 'cancelled', 'skipped', '']) {
            const run = spawnSync('bash', ['-c', gate.steps[0].run], {
                env: {LOCK_RESULT: result, GITHUB_STEP_SUMMARY: '/dev/null'},
                encoding: 'utf8',
            });
            assert.equal(run.status, result === 'success' ? 0 : 1);
        }
    },
});

tests.push({
    name: 'Master Sonar analysis remains enabled, except for Dependabot-triggered pushes',
    fn: () => {
        assert.equal(evaluate(sonar.if, context('maintainer', 'maintainer', false, 'push')), true);
        assert.equal(
            evaluate(sonar.if, context('dependabot[bot]', 'dependabot[bot]', false, 'push')),
            false,
        );
    },
});

module.exports = {tests};
