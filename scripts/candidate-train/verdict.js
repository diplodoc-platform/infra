'use strict';

const assert = require('node:assert/strict');
const {digest, validatePlan} = require('./common');

const VERIFIER_APP_ID = 2126995; // diplodoc-app, distinct from the infrastructure publisher.
const VERDICT_MARKER = 'DEPENDENCY_TRAIN_VERDICT_V1';
const sources = (plan) =>
    plan.selected.map(({repo, number, sha, baseSha}) => ({repo, number, sha, baseSha}));

/** Only the App's latest attempt may authorize merging the exact frozen group. */
function verifiedVerdict(checks, candidate, planBytes, proofBytes) {
    const plan = validatePlan(JSON.parse(planBytes));
    const proof = JSON.parse(proofBytes);
    assert.equal(proof.schema, 3, 'Frozen installed trees are required for a merge verdict');
    const attempts = checks
        .filter(
            (check) =>
                check.app?.id === VERIFIER_APP_ID &&
                ['Internal check', 'Internal check (manual)'].includes(check.name) &&
                check.head_sha === candidate.sha,
        )
        .sort((a, b) => b.id - a.id);
    const latest = attempts[0];
    assert.ok(latest, 'Missing trusted Internal Check');
    assert.equal(latest.status, 'completed', 'Latest Internal Check is not complete');
    assert.equal(latest.conclusion, 'success', 'Latest Internal Check did not succeed');
    const text = latest.output?.text || '';
    assert.ok(text.length <= 128 * 1024, 'Oversized verification output');
    const marker = `\n${VERDICT_MARKER}\n`;
    assert.equal(text.split(marker).length, 2, 'Missing or ambiguous exact-train verdict');
    const verdict = JSON.parse(text.split(marker)[1]);
    assert.deepEqual(Object.keys(verdict).sort(), [
        'candidate',
        'cliBaseSha',
        'evidence',
        'payloadSha256',
        'planSha256',
        'schema',
        'sources',
        'toolSha',
        'trainId',
    ]);
    assert.equal(verdict.schema, 1);
    assert.deepEqual(verdict.candidate, candidate);
    assert.equal(verdict.trainId, plan.id);
    assert.equal(verdict.toolSha, plan.toolSha);
    assert.equal(verdict.cliBaseSha, plan.cli.sha);
    assert.equal(verdict.planSha256, digest(planBytes));
    assert.equal(verdict.payloadSha256, digest(proofBytes));
    assert.equal(proof.trainId, plan.id);
    assert.equal(proof.toolSha, plan.toolSha);
    assert.equal(proof.cliBaseSha, plan.cli.sha);
    assert.deepEqual(verdict.sources, sources(plan));
    assert.deepEqual(Object.keys(verdict.evidence).sort(), [
        'documents',
        'installed',
        'launch',
        'version',
    ]);
    assert.equal(verdict.evidence.version, 1);
    assert.equal(verdict.evidence.documents, true);
    assert.equal(verdict.evidence.installed, true);
    assert.ok(Number.isSafeInteger(verdict.evidence.launch) && verdict.evidence.launch > 0);
    return {plan, verdict, checkId: latest.id};
}

module.exports = {VERIFIER_APP_ID, VERDICT_MARKER, sources, verifiedVerdict};
