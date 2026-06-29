const assert = require('node:assert');

const {
    daysUntil,
    normalizeToken,
    findBotToken,
    evaluateExpiry,
} = require('../../scripts/check-pat-expiry');

const tests = [];
function test(name, fn) {
    tests.push({name, fn});
}

const NOW = new Date('2026-01-01T00:00:00Z');
const iso = (days) => new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000).toISOString();

// --- daysUntil ------------------------------------------------------------

test('daysUntil: future date', () => {
    assert.strictEqual(daysUntil(iso(30), NOW), 30);
});

test('daysUntil: past date is negative', () => {
    assert.strictEqual(daysUntil(iso(-5), NOW), -5);
});

test('daysUntil: no date is Infinity', () => {
    assert.strictEqual(daysUntil(null, NOW), Infinity);
    assert.strictEqual(daysUntil('not-a-date', NOW), Infinity);
});

// --- normalizeToken -------------------------------------------------------

test('normalizeToken: reads token_expires_at and token_expired', () => {
    assert.deepStrictEqual(normalizeToken({token_expires_at: iso(10), token_expired: false}), {
        expiresAt: iso(10),
        expired: false,
    });
});

test('normalizeToken: falls back to expires_at', () => {
    const {expiresAt} = normalizeToken({expires_at: iso(3)});
    assert.strictEqual(expiresAt, iso(3));
});

// --- findBotToken ---------------------------------------------------------

test('findBotToken: filters by owner login', () => {
    const tokens = [
        {id: 1, owner: {login: 'someone-else'}, token_expires_at: iso(1)},
        {id: 2, owner: {login: 'diplodoc-bot'}, token_expires_at: iso(40)},
    ];
    assert.strictEqual(findBotToken(tokens, 'diplodoc-bot').id, 2);
});

test('findBotToken: picks soonest expiry among the bot tokens', () => {
    const tokens = [
        {id: 2, owner: {login: 'diplodoc-bot'}, token_expires_at: iso(40)},
        {id: 3, owner: {login: 'diplodoc-bot'}, token_expires_at: iso(5)},
    ];
    assert.strictEqual(findBotToken(tokens, 'diplodoc-bot').id, 3);
});

test('findBotToken: none returns null', () => {
    assert.strictEqual(findBotToken([{owner: {login: 'x'}}], 'diplodoc-bot'), null);
});

// --- evaluateExpiry -------------------------------------------------------

test('evaluateExpiry: ok when far from threshold', () => {
    const tokens = [{id: 1, owner: {login: 'diplodoc-bot'}, token_expires_at: iso(40)}];
    const r = evaluateExpiry({tokens, login: 'diplodoc-bot', thresholdDays: 14, now: NOW});
    assert.strictEqual(r.status, 'ok');
    assert.strictEqual(r.daysLeft, 40);
    assert.strictEqual(r.tokenId, 1);
});

test('evaluateExpiry: warn within threshold', () => {
    const tokens = [{id: 1, owner: {login: 'diplodoc-bot'}, token_expires_at: iso(10)}];
    const r = evaluateExpiry({tokens, login: 'diplodoc-bot', thresholdDays: 14, now: NOW});
    assert.strictEqual(r.status, 'warn');
    assert.strictEqual(r.daysLeft, 10);
});

test('evaluateExpiry: expired by date', () => {
    const tokens = [{id: 1, owner: {login: 'diplodoc-bot'}, token_expires_at: iso(-2)}];
    const r = evaluateExpiry({tokens, login: 'diplodoc-bot', thresholdDays: 14, now: NOW});
    assert.strictEqual(r.status, 'expired');
});

test('evaluateExpiry: expired by flag', () => {
    const tokens = [
        {id: 1, owner: {login: 'diplodoc-bot'}, token_expires_at: iso(5), token_expired: true},
    ];
    const r = evaluateExpiry({tokens, login: 'diplodoc-bot', thresholdDays: 14, now: NOW});
    assert.strictEqual(r.status, 'expired');
});

test('evaluateExpiry: missing token', () => {
    const r = evaluateExpiry({tokens: [], login: 'diplodoc-bot', thresholdDays: 14, now: NOW});
    assert.strictEqual(r.status, 'missing');
    assert.strictEqual(r.daysLeft, null);
});

module.exports = {tests};
