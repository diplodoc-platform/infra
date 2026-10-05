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

module.exports = {DEFAULT_PROFILE_BY_RISK, DEEP_PROFILES, SUPPORTED_PROFILES};
