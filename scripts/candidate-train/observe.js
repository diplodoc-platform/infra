'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const {OWNER, read, write, validatePlan, github} = require('./common');
const {unchangedSources} = require('./publish');
const {inspectInternal, settings} = require('./internal');
const {notify} = require('./notify');
const {fetchRequiredChecks, fetchCheckRuns, deriveChecksGreen} = require('../auto-merge');

const INTERNAL_APP_ID = 2126995;
const INTERNAL_NAMES = new Set(['Internal check', 'Internal check (manual)']);

function internalCheck(checks, candidate, binding) {
    const runs = checks.filter(
        (check) =>
            check.head_sha === candidate.sha &&
            check.app?.id === INTERNAL_APP_ID &&
            INTERNAL_NAMES.has(check.name),
    );
    runs.sort((left, right) => right.id - left.id);
    if (!runs.length) return null;
    const check = runs[0];
    if (binding.checkId)
        assert.equal(
            check.id,
            binding.checkId,
            'Internal check was replaced; observe the new attempt explicitly',
        );
    binding.checkId = check.id;
    return check;
}

function publicState(candidate, state, extra = {}) {
    return {
        schema: 1,
        trainId: candidate.plan.id,
        cliPr: candidate.url,
        cliSha: candidate.sha,
        state,
        ...extra,
    };
}

async function observe(candidate, env = process.env, deps = {}) {
    validatePlan(candidate.plan);
    assert.equal(candidate.plan.toolSha, env.GITHUB_SHA);
    assert.equal(env.DEPENDENCY_CANDIDATE_TRAIN_ENABLED, 'true');
    settings(env.DEPENDENCY_TRAIN_INTERNAL);
    const request = deps.request || github;
    const inspect = deps.inspect || inspectInternal;
    const send = deps.notify || notify;
    const now = deps.now || Date.now;
    const pause = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const checksAt = deps.checks || ((sha) => fetchCheckRuns(env.GH_TOKEN, OWNER, 'cli', sha));
    const requiredAt =
        deps.required || (() => fetchRequiredChecks(env.GH_TOKEN, OWNER, 'cli', 'master'));
    const persist = deps.persist || ((state) => write('train-result.json', state));
    const binding = {};
    const deadline = now() + 5 * 60 * 60_000;
    let readyAt;
    let lastState;
    let reminded = false;
    const readyBy = Date.parse(candidate.plan.readyBy);
    assert.ok(Number.isFinite(readyBy));
    const timing = () => ({
        readyAt: readyAt || null,
        late: readyAt ? Date.parse(readyAt) > readyBy : now() > readyBy,
    });

    try {
        while (now() < deadline) {
            await unchangedSources(candidate.plan, request);
            const pr = await request(`/repos/${OWNER}/cli/pulls/${candidate.number}`);
            assert.equal(pr.state, 'open');
            assert.equal(pr.head.sha, candidate.sha, 'CLI candidate head changed');
            assert.equal(pr.head.ref, candidate.branch);
            assert.equal(pr.head.repo.full_name, `${OWNER}/cli`);
            const all = await checksAt(candidate.sha);
            const check = internalCheck(all.check_runs, candidate, binding);
            let snapshot = check
                ? await inspect(candidate, check, binding, env)
                : {state: 'waiting-for-internal-check'};

            if (snapshot.manualStartUrl && !readyAt) {
                readyAt = new Date(now()).toISOString();
                await send(
                    candidate.plan,
                    'manual-ready',
                    `Dependabot candidate train ${candidate.plan.id}\n` +
                        `CLI: ${candidate.url}\nSHA: ${candidate.sha}\n` +
                        `Ready for manual start: ${readyAt}. Target: 08:00 Moscow.\n` +
                        (now() > readyBy
                            ? 'Preparation is late; this is not a passed check.\n'
                            : '') +
                        (snapshot.state === 'waiting-for-manual-start'
                            ? 'Open Merge checks and press Start all CI checks:\n'
                            : 'Document checks are already running or completed; inspect their state:\n') +
                        `${snapshot.manualStartUrl}\n` +
                        `The train is waiting for the result. No merge or distribution will run.`,
                    env,
                );
            }
            if (
                snapshot.manualStartUrl &&
                !reminded &&
                now() >= readyBy &&
                snapshot.state === 'waiting-for-manual-start'
            ) {
                await send(
                    candidate.plan,
                    'morning-reminder',
                    `08:00 Moscow: candidate ${candidate.url} is waiting for your manual start.\n` +
                        `${snapshot.manualStartUrl}\nExpected running time is about an hour; success is based on the result, not the clock.`,
                    env,
                );
                reminded = true;
            }
            if (
                snapshot.state === 'documents-passed' &&
                check.status === 'completed' &&
                check.conclusion === 'success'
            ) {
                const required = await requiredAt();
                if (deriveChecksGreen(all, required, candidate.sha)) {
                    for (const source of candidate.plan.selected) {
                        const sourceChecks = deps.sourceChecks
                            ? await deps.sourceChecks(source)
                            : await fetchCheckRuns(env.GH_TOKEN, OWNER, source.repo, source.sha);
                        const sourceRequired = deps.sourceRequired
                            ? await deps.sourceRequired(source)
                            : await fetchRequiredChecks(env.GH_TOKEN, OWNER, source.repo, 'master');
                        assert.ok(
                            deriveChecksGreen(sourceChecks, sourceRequired, source.sha),
                            'Source CI is no longer green',
                        );
                    }
                    snapshot = {...snapshot, state: 'passed'};
                }
            }
            if (
                check?.status === 'completed' &&
                !['success', 'action_required'].includes(check.conclusion)
            ) {
                snapshot = {...snapshot, state: 'failed'};
            }
            if (lastState !== snapshot.state) {
                persist(publicState(candidate, snapshot.state, timing()));
                // Keep internal URLs, review identifiers and diagnostics out of public Actions logs/artifacts.
                console.log(`Candidate state: ${snapshot.state}`);
                lastState = snapshot.state;
            }
            if (['passed', 'failed'].includes(snapshot.state)) {
                await unchangedSources(candidate.plan, request);
                await send(
                    candidate.plan,
                    'result',
                    `Candidate train ${candidate.plan.id}: ${snapshot.state.toUpperCase()}\n` +
                        `CLI: ${candidate.url}\nSHA: ${candidate.sha}\n` +
                        (snapshot.manualStartUrl ? `${snapshot.manualStartUrl}\n` : '') +
                        `Sources: ${candidate.plan.selected.map((item) => `${item.repo}#${item.number}@${item.sha}`).join(', ')}\n` +
                        `Nothing was merged or distributed. Review source PRs manually.`,
                    env,
                );
                return publicState(candidate, snapshot.state, timing());
            }
            await pause(60_000);
        }
        await send(
            candidate.plan,
            'timeout',
            `Candidate ${candidate.url}: observation timed out, NOT passed.\n` +
                (binding.reviewNumber
                    ? 'The generated review is still linked in the earlier private message.\n'
                    : '') +
                `Candidate head: ${candidate.sha}. No PR was merged or distributed.`,
            env,
        );
        return publicState(candidate, 'timed-out', timing());
    } catch (error) {
        persist(publicState(candidate, 'blocked', timing()));
        await send(
            candidate.plan,
            'observer-error',
            `Candidate ${candidate.url}: verification could not be completed.\n${error.message.slice(0, 1500)}\n` +
                `No success is recorded. No merge or distribution.`,
            env,
        );
        throw new Error('Candidate observation failed; diagnostics were sent privately');
    }
}

if (require.main === module) {
    const candidate = read(process.argv[2]);
    observe(candidate)
        .then((result) => {
            write('train-result.json', result);
            fs.appendFileSync(
                process.env.GITHUB_STEP_SUMMARY,
                `## Dependency candidate train\n\nState: **${result.state}**. ` +
                    `[CLI candidate](${candidate.url}). Internal details are sent privately in Messenger.\n`,
            );
            if (result.state !== 'passed') process.exitCode = 1;
        })
        .catch(() => {
            console.error('Candidate observation failed; no success recorded');
            process.exitCode = 1;
        });
}

module.exports = {INTERNAL_APP_ID, internalCheck, publicState, observe};
