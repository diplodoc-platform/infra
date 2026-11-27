'use strict';

const assert = require('node:assert/strict');
const {mkdtempSync, readFileSync, rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {
    readRefreshReceipt,
    waitForRefreshedGroup,
    writeRefreshReceipt,
} = require('../../scripts/candidate-train/refresh-receipt');
const {refreshedGroup} = require('../../scripts/candidate-train/plan');
const {comparisonEvidence} = require('./candidate-deep-profile.test');

const tests = [];
const test = (name, fn) => tests.push({name, fn});
const sha = (char) => char.repeat(40);
const source = {
    repo: 'tabs-extension',
    number: 170,
    sha: sha('b'),
    baseSha: sha('c'),
    risk: 'low',
    profile: 'standard',
};
const group = {
    dependency: {name: 'example', version: '1.2.3'},
    baseline: [{repo: 'transform', sha: sha('e')}],
    requests: [{repo: source.repo, number: source.number}],
};
const receipt = {...group, toolSha: sha('d'), sources: [source]};

function fixture(item = source) {
    const prefix = `/repos/diplodoc-platform/${item.repo}`;
    const repo = {full_name: `diplodoc-platform/${item.repo}`};
    const pr = {
        number: item.number,
        state: 'open',
        draft: false,
        head: {sha: item.sha, repo},
        base: {ref: 'master', sha: item.baseSha, repo},
    };
    const master = {commit: {sha: item.baseSha}};
    const green = {
        id: 1,
        name: 'Run tests',
        app: {id: 15368},
        head_sha: item.sha,
        status: 'completed',
        conclusion: 'success',
    };
    const runs = [green];
    const other = new Map();
    const request = async (route) => {
        if (route === `${prefix}/pulls/${item.number}`) return pr;
        if (route === `${prefix}/branches/master`) return master;
        assert.ok(other.has(route), route);
        return other.get(route);
    };
    const evidence = {
        fetchCheckRuns: async (token, owner, target, head) => {
            assert.deepEqual(
                [token, owner, target, head],
                ['readonly', 'diplodoc-platform', item.repo, item.sha],
            );
            return {check_runs: runs};
        },
        fetchRequiredChecks: async () => [{context: 'Run tests', appId: 15368}],
    };
    const wait = (options) =>
        waitForRefreshedGroup({...receipt, sources: [item]}, request, 'readonly', {
            evidence,
            report: () => {},
            timeout: 0,
            ...options,
        });
    return {pr, master, green, runs, wait, other, prefix};
}

test('Refresh receipt accepts only the recorded group from the same trusted Morning revision', () => {
    const folder = mkdtempSync(join(tmpdir(), 'refresh-receipt-'));
    const output = join(folder, 'outputs');
    const env = {
        GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: 'diplodoc-platform/infra',
        GITHUB_REF: 'refs/heads/master',
        GITHUB_SHA: receipt.toolSha,
        DEPENDENCY_TRAIN_SELECTION_MODE: 'cohort',
        DEPENDENCY_TRAIN_INLINE_REFRESH: 'true',
    };
    try {
        writeRefreshReceipt({toolSha: receipt.toolSha, group}, [source], env);
        const raw = readFileSync(output, 'utf8').trim();
        assert.match(raw, /^receipt=/);
        const resume = {...env, DEPENDENCY_TRAIN_REFRESH_RECEIPT: raw.slice('receipt='.length)};
        assert.deepEqual(readRefreshReceipt(resume), receipt);
        assert.throws(() => readRefreshReceipt({...resume, GITHUB_SHA: sha('f')}));
        assert.throws(() => readRefreshReceipt({...resume, GITHUB_REF: 'refs/heads/codex/test'}));
        assert.throws(() => readRefreshReceipt({...resume, DEPENDENCY_TRAIN_WAVE: '2'}));
    } finally {
        rmSync(folder, {recursive: true, force: true});
    }
});

test('Morning waits for the newest check from the expected publisher on the refreshed head', async () => {
    const f = fixture();
    const queued = {...f.green, id: 2, status: 'queued'};
    f.runs.push(
        queued,
        {...f.green, id: 3, head_sha: sha('a')},
        {...f.green, id: 4, app: {id: 42}},
    );
    let polls = 0;
    await f.wait({
        timeout: 60_000,
        sleep: async () => {
            assert.equal(++polls, 1);
            queued.status = 'completed';
        },
    });
    assert.equal(polls, 1);
});

test('Morning stops on a failing check, missing CI evidence or a changed source ref', async () => {
    const failed = fixture();
    failed.green.conclusion = 'failure';
    await assert.rejects(failed.wait(), /Run tests ended with failure/);

    const missing = fixture();
    missing.green.head_sha = sha('a');
    await assert.rejects(missing.wait(), /Timed out.*source CI/);

    const moving = fixture();
    moving.pr.head.sha = sha('a');
    await assert.rejects(moving.wait(), /source head changed/);

    const stale = fixture();
    stale.master.commit.sha = sha('a');
    await assert.rejects(stale.wait(), /master changed/);
});

test('Morning waits for the comparison and still requires proof of the exact deep profile', async () => {
    const item = {...source, risk: 'critical', profile: 'ecosystem'};
    const f = fixture(item);
    const {check, run, artifact} = comparisonEvidence(item);
    check.status = 'in_progress';
    f.runs.push(check);
    const path = `${f.prefix}/actions/runs/${run.id}`;
    f.other.set(path, run);
    f.other.set(`${path}/artifacts?name=${artifact.name}`, {artifacts: [artifact]});
    let polls = 0;
    await f.wait({
        timeout: 60_000,
        sleep: async () => {
            assert.equal(++polls, 1);
            check.status = 'completed';
        },
    });
    assert.equal(polls, 1);
    artifact.expired = true;
    await assert.rejects(f.wait(), /required ecosystem comparison/);
});

test('Morning cannot switch to a different group or accept a changed head, base or profile after waiting', () => {
    const another = {...group, dependency: {name: 'another', version: '1.0.1'}};
    assert.equal(refreshedGroup(receipt, [another, group], [source]), group);
    assert.throws(() => refreshedGroup(receipt, [another], [source]), /no longer eligible/);
    assert.throws(
        () => refreshedGroup(receipt, [{...group, baseline: []}], [source]),
        /no longer eligible/,
    );
    for (const patch of [{sha: sha('a')}, {baseSha: sha('a')}, {profile: 'ecosystem'}]) {
        assert.throws(
            () => refreshedGroup(receipt, [group], [{...source, ...patch}]),
            /refreshed .* changed/,
        );
    }
});

module.exports = {tests};
