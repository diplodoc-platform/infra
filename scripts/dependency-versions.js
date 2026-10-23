'use strict';

/** Extract comparable components from a dependency version specifier. */
function parseSemver(version) {
    if (typeof version !== 'string' || version.length === 0) return null;

    const cleaned = version
        .replace(/^[^0-9]*/, '')
        .split('-')[0]
        .split('+')[0];
    const parts = cleaned.split('.');
    const major = parseInt(parts[0], 10);
    const minor = parts.length > 1 ? parseInt(parts[1], 10) : 0;
    const patch = parts.length > 2 ? parseInt(parts[2], 10) : 0;

    if (Number.isNaN(major) || Number.isNaN(minor) || Number.isNaN(patch)) return null;
    return {major, minor, patch};
}

function classifyVersionChange(from, to) {
    const previous = parseSemver(from);
    const next = parseSemver(to);

    if (!previous || !next) return 'unknown';
    if (previous.major !== next.major) return 'major';
    if (previous.minor !== next.minor) return 'minor';
    return 'patch';
}

module.exports = {parseSemver, classifyVersionChange};
