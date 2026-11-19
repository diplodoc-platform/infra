'use strict';

const assert = require('node:assert/strict');
const {RISK_WEIGHT} = require('../risk-classification');
const {DEFAULT_PROFILE_BY_RISK, strongestProfile} = require('../dependency-verification-profiles');

function riskWeight(risk) {
    assert.ok(Object.hasOwn(RISK_WEIGHT, risk), 'Unknown candidate risk');
    return RISK_WEIGHT[risk];
}

function groupRisk(sources) {
    return sources.reduce(
        (highest, {risk}) => (riskWeight(risk) > riskWeight(highest) ? risk : highest),
        'low',
    );
}

function riskSelection(env, mode) {
    const exact = env.DEPENDENCY_TRAIN_RISK_LEVEL || 'auto';
    if (mode === 'wave') {
        assert.ok(['auto', 'low'].includes(exact), 'Legacy waves support low risk only');
        return {maxRisk: 'low'};
    }
    if (exact !== 'auto') {
        assert.equal(
            env.GITHUB_EVENT_NAME,
            'workflow_dispatch',
            'Specific risk requires a manual dispatch',
        );
        riskWeight(exact);
        return {maxRisk: exact, exact};
    }
    const maxRisk = env.DEPENDENCY_TRAIN_MAX_RISK || 'low';
    riskWeight(maxRisk);
    return {maxRisk};
}

function assertRiskAllowed(risk, maxRisk) {
    if (maxRisk === 'low')
        assert.equal(risk, 'low', 'Only low-risk updates are eligible for a train');
    assert.ok(riskWeight(risk) <= riskWeight(maxRisk), `Candidate risk exceeds ${maxRisk}`);
}

function assertRiskProfile(risk, profile) {
    riskWeight(risk);
    assert.ok(
        strongestProfile([profile, DEFAULT_PROFILE_BY_RISK[risk]]) === strongestProfile([profile]),
        'Candidate verification profile is below required risk coverage',
    );
}

module.exports = {riskWeight, groupRisk, riskSelection, assertRiskAllowed, assertRiskProfile};
