'use strict';

const assert = require('node:assert/strict');

async function notify(plan, event, text, env = process.env, fetcher = fetch) {
    assert.match(env.DEPENDENCY_TRAIN_NOTIFY_LOGIN || '', /^[a-z0-9][a-z0-9-]*$/);
    assert.ok(env.TRAIN_MESSENGER_TOKEN, 'Messenger bot credential is missing');
    const base = env.DEPENDENCY_TRAIN_MESSENGER_API || 'https://bp.mssngr.yandex.net/public';
    assert.ok(
        ['https://bp.mssngr.yandex.net/public', 'https://botapi.messenger.yandex.net'].includes(
            base,
        ),
    );
    const auth = base.includes('bp.mssngr.') ? 'OAuthTeam' : 'OAuth';
    assert.ok(text.length > 0 && text.length <= 6000);
    const response = await fetcher(`${base}/bot/v1/messages/sendText`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
        headers: {
            Authorization: `${auth} ${env.TRAIN_MESSENGER_TOKEN}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            login: env.DEPENDENCY_TRAIN_NOTIFY_LOGIN,
            text,
            payload_id: `dependency-train:${plan.id}:${event}`,
            disable_web_page_preview: true,
        }),
    });
    assert.ok(response.ok, `Messenger delivery failed: HTTP ${response.status}`);
    const body = await response.json();
    assert.equal(body.ok, true, 'Messenger rejected the notification');
    assert.equal(body.chat?.type, 'private', 'Notification must be a direct message');
    return body.message_id;
}

module.exports = {notify};

if (require.main === module) {
    const text =
        `Dependency candidate preparation failed before the observer could start.\n` +
        `${process.env.TRAIN_RUN_URL}\nNo successful verification, merge or distribution is recorded.`;
    notify({id: process.env.GITHUB_RUN_ID}, 'preparation-failed', text).catch(() => {
        console.error('Private preparation-failure notification could not be delivered');
        process.exitCode = 1;
    });
}
