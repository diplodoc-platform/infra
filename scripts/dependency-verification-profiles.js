'use strict';

// Keep classifier defaults and workflow decisions on the same profile contract.
const DEFAULT_PROFILE_BY_RISK = Object.freeze({
    low: 'standard',
    medium: 'toolchain',
    high: 'document-transform',
    critical: 'ecosystem',
});

const DEEP_PROFILES = Object.freeze(['document-transform', 'document-rendering', 'ecosystem']);
const SUPPORTED_PROFILES = Object.freeze([
    'standard',
    'toolchain',
    // Preserve the earlier exporter's non-deep alias for existing assessment artifacts.
    'standard-ci',
    ...DEEP_PROFILES,
]);

// Every stronger profile contains the coverage of the profiles before it.
const PROFILE_COVERAGE = Object.freeze({
    standard: 0,
    'standard-ci': 0,
    toolchain: 1,
    'document-transform': 2,
    'document-rendering': 3,
    ecosystem: 4,
});

function strongestProfile(profiles) {
    let selected = 'standard';

    for (const profile of profiles) {
        if (!Object.hasOwn(PROFILE_COVERAGE, profile)) {
            throw new Error(`Unsupported verification profile: ${profile}`);
        }
        if (PROFILE_COVERAGE[profile] > PROFILE_COVERAGE[selected]) selected = profile;
    }

    return selected;
}

module.exports = {DEFAULT_PROFILE_BY_RISK, DEEP_PROFILES, SUPPORTED_PROFILES, strongestProfile};
