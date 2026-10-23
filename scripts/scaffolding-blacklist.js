'use strict';

function readBlacklist(env = process.env) {
    try {
        const entries = JSON.parse(env.INFRA_BLACKLIST || '[]');
        return Array.isArray(entries) ? entries.filter((entry) => typeof entry === 'string') : [];
    } catch {
        return [];
    }
}

function isExcluded(filePath, patterns) {
    const normalized = filePath.replace(/\\/g, '/');
    return patterns.some((entry) => {
        const pattern = entry.replace(/\\/g, '/').replace(/\/$/, '');
        if (!pattern) return false;
        if (!pattern.includes('*')) {
            return normalized === pattern || normalized.startsWith(pattern + '/');
        }

        // Keep the scaffolding wildcard semantics: * matches within one directory.
        const expression = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
        const matcher = new RegExp(`^${expression}$`);
        const segments = normalized.split('/');
        return segments.some((_, index) => matcher.test(segments.slice(0, index + 1).join('/')));
    });
}

module.exports = {readBlacklist, isExcluded};
