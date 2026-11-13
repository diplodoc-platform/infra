'use strict';

// Bounded npm stable ranges for frozen peer providers. Unsupported syntax fails
// closed; prerelease selection requires a separate explicit compatibility check.
function parts(value) {
    if (!/^(0|[1-9]\d*)(?:\.(0|[1-9]\d*|[xX*]))?(?:\.(0|[1-9]\d*|[xX*]))?$/.test(value))
        return null;
    const tokens = value.split('.');
    const firstWildcard = tokens.findIndex((token) => /^[xX*]$/.test(token));
    if (firstWildcard >= 0 && tokens.slice(firstWildcard).some((token) => !/^[xX*]$/.test(token)))
        return null;
    const numbers = tokens.slice(0, firstWildcard < 0 ? tokens.length : firstWildcard).map(Number);
    return numbers.every(Number.isSafeInteger)
        ? {precision: numbers.length, value: [numbers[0] || 0, numbers[1] || 0, numbers[2] || 0]}
        : null;
}
function compare(a, b) {
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}
function nextPartial(base) {
    return base.precision === 1 ? [base.value[0] + 1, 0, 0] : [base.value[0], base.value[1] + 1, 0];
}
function satisfiesStable(version, range) {
    const actual = parts(version);
    if (
        !actual ||
        actual.precision !== 3 ||
        /[xX*]/.test(version) ||
        typeof range !== 'string' ||
        !range.trim() ||
        range.length > 1000
    )
        return false;
    const groups = range.split('||').map((group) => group.trim());
    if (groups.some((group) => !group)) return false;
    const parsed = groups.map((group) =>
        group
            .replace(/([<>]=?|[=^~])\s+/g, '$1')
            .split(/\s+/)
            .map((token) => {
                if (/^[xX*]$/.test(token)) return () => true;
                const match = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(token);
                const base = match && parts(match[2]);
                if (!base) return null;
                const delta = compare(actual.value, base.value);
                switch (match[1] || '=') {
                    case '=':
                        return () =>
                            base.precision === 3
                                ? delta === 0
                                : delta >= 0 && compare(actual.value, nextPartial(base)) < 0;
                    case '>':
                        return () =>
                            base.precision === 3
                                ? delta > 0
                                : compare(actual.value, nextPartial(base)) >= 0;
                    case '>=':
                        return () => delta >= 0;
                    case '<':
                        return () => delta < 0;
                    case '<=':
                        return () =>
                            base.precision === 3
                                ? delta <= 0
                                : compare(actual.value, nextPartial(base)) < 0;
                    case '~':
                        return () =>
                            delta >= 0 &&
                            compare(
                                actual.value,
                                nextPartial(base.precision === 3 ? {...base, precision: 2} : base),
                            ) < 0;
                    case '^': {
                        const upper =
                            base.value[0] || base.precision === 1
                                ? [base.value[0] + 1, 0, 0]
                                : base.value[1] || base.precision === 2
                                  ? [0, base.value[1] + 1, 0]
                                  : [0, 0, base.value[2] + 1];
                        return () => delta >= 0 && compare(actual.value, upper) < 0;
                    }
                    default:
                        return null;
                }
            }),
    );
    return (
        !parsed.some((group) => group.some((test) => !test)) &&
        parsed.some((group) => group.every((test) => test()))
    );
}
module.exports = {satisfiesStable};
