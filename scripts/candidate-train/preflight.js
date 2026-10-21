'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {settings, ciRead, reviewRead} = require('./internal');

async function preflight(env = process.env, fetcher = fetch) {
    assert.equal(env.DEPENDENCY_CANDIDATE_TRAIN_ENABLED, 'true');
    const config = settings(env.DEPENDENCY_TRAIN_INTERNAL);
    assert.ok(env.TRAIN_CI_TOKEN && env.TRAIN_REVIEW_TOKEN && env.TRAIN_MESSENGER_TOKEN);
    assert.match(env.DEPENDENCY_TRAIN_NOTIFY_LOGIN || '', /^[a-z0-9][a-z0-9-]*$/);
    assert.ok(
        Number.isSafeInteger(config.preflightReview) && config.preflightReview > 0,
        'A known review id is required for the read-only connectivity preflight',
    );
    await ciRead(
        'ActionService/GetActionSettings',
        {
            action_id: {
                config_path: config.configPath,
                action_id: config.actions[0],
            },
        },
        config,
        env.TRAIN_CI_TOKEN,
    );
    await reviewRead(
        `/v1/pull-requests/${config.preflightReview}/active-diff?fields=commit_ids(base,merge),id`,
        config,
        env.TRAIN_REVIEW_TOKEN,
    );
    const base = env.DEPENDENCY_TRAIN_MESSENGER_API || 'https://bp.mssngr.yandex.net/public';
    assert.ok(
        ['https://bp.mssngr.yandex.net/public', 'https://botapi.messenger.yandex.net'].includes(
            base,
        ),
    );
    const scheme = base.includes('bp.mssngr.') ? 'OAuthTeam' : 'OAuth';
    const response = await fetcher(`${base}/bot/v1/self/get`, {
        headers: {Authorization: `${scheme} ${env.TRAIN_MESSENGER_TOKEN}`},
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
    });
    assert.ok(response.ok);
    assert.equal((await response.json()).ok, true, 'Messenger bot is unavailable');
}

if (require.main === module) {
    if (process.argv[2] === 'ca') {
        fs.writeFileSync(
            path.join(process.env.RUNNER_TEMP, 'dependency-train-ca.pem'),
            process.env.TRAIN_CA_PEM || '',
            {mode: 0o600},
        );
    } else {
        preflight().catch(() => {
            console.error('Private integration preflight failed; no candidate will be published');
            process.exitCode = 1;
        });
    }
}

module.exports = {preflight};
