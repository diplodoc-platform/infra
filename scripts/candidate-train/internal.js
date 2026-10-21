'use strict';

const assert = require('node:assert/strict');
const {SHA} = require('./common');

function settings(raw) {
    const value = JSON.parse(raw || '{}');
    for (const name of ['apiUrl', 'uiOrigin', 'reviewApiUrl', 'reviewUiOrigin', 'artifactOrigin']) {
        const url = new URL(value[name]);
        assert.equal(url.protocol, 'https:');
        assert.ok(!url.username && !url.password && !url.search && !url.hash);
    }
    assert.ok(typeof value.configPath === 'string' && value.configPath.endsWith('/a.yaml'));
    assert.ok(Array.isArray(value.actions) && value.actions.length > 0);
    assert.ok(value.actions.every((name) => /^[a-z0-9-]+$/.test(name)));
    for (const name of ['uiOrigin', 'reviewUiOrigin', 'artifactOrigin']) {
        assert.equal(new URL(value[name]).pathname, '/');
        value[name] = new URL(value[name]).origin;
    }
    value.apiUrl = value.apiUrl.replace(/\/$/, '');
    value.reviewApiUrl = value.reviewApiUrl.replace(/\/$/, '');
    return value;
}

async function boundedFetch(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000),
    });
    assert.ok(
        (response.status >= 200 && response.status < 400) || response.status === 404,
        `Internal read: HTTP ${response.status}`,
    );
    return response;
}

async function flowLink(check, config, fetcher = boundedFetch) {
    const text = [check.details_url, check.output?.summary, check.output?.text]
        .filter(Boolean)
        .join('\n');
    for (const raw of text.match(/https:\/\/[^\s<>"')\]]+/g) || []) {
        let url = new URL(raw);
        if (url.origin === 'https://nda.ya.ru' && url.pathname.startsWith('/t/')) {
            const response = await fetcher(url.href);
            const redirect = response.headers.get('location');
            if (!redirect) continue;
            url = new URL(redirect);
        }
        if (url.origin !== config.uiOrigin || !url.pathname.endsWith('/ci/actions/flow')) continue;
        assert.ok(!url.username && !url.password);
        const configPath = `${url.searchParams.get('dir')}/a.yaml`;
        const action = url.searchParams.get('id');
        const number = Number(url.searchParams.get('number'));
        assert.equal(configPath, config.configPath);
        assert.ok(config.actions.includes(action));
        assert.ok(Number.isSafeInteger(number) && number > 0);
        return {
            url: url.href,
            launch_id: {
                action_process_id: {config_path: configPath, action_id: action},
                launch_number: number,
            },
        };
    }
    return null;
}

async function ciRead(method, body, config, token, fetcher = boundedFetch) {
    assert.ok(
        [
            'LaunchService/GetFlowLaunch',
            'JobLaunchService/GetJobLaunch',
            'ActionService/GetActionSettings',
        ].includes(method),
    );
    assert.ok(token, 'CI read credential is missing');
    const response = await fetcher(`${config.apiUrl}/api/public/v1/ci.public_api.${method}`, {
        method: 'POST',
        headers: {Authorization: `OAuth ${token}`, 'Content-Type': 'application/json'},
        body: JSON.stringify(body),
    });
    assert.ok(response.status < 300, 'CI read redirected; credentials were not forwarded');
    return response.json();
}

async function reviewRead(route, config, token, fetcher = boundedFetch) {
    assert.ok(token, 'Review read credential is missing');
    assert.ok(/^\/v1\/(?:pull-requests|review-requests)\/[1-9][0-9]*(?:\/|\?)/.test(route));
    const response = await fetcher(`${config.reviewApiUrl}${route}`, {
        headers: {Authorization: `OAuth ${token}`},
    });
    assert.ok(response.status < 300, 'Review read redirected; credentials were not forwarded');
    const body = await response.json();
    assert.ok(!body.errors?.length && body.data, 'Incomplete review evidence');
    return body.data;
}

function boundFlow(body, candidate) {
    const flow = body.flow_launch_state || body.flowLaunchState;
    assert.ok(flow, 'Missing flow launch state');
    const variables = flow.flow_vars || flow.flowVars;
    const vars = JSON.parse(variables?.json || '{}');
    assert.equal(vars.docsViewer?.sha, candidate.sha, 'Flow runs a different CLI SHA');
    assert.equal(vars.docsViewer?.prNumber, candidate.number);
    assert.equal(vars.branch, candidate.branch);
    assert.equal(vars.skipTests, false, 'Internal tests must not be skipped');
    // updateSnapshots is deliberately not a gate: the owner accepted the
    // existing prerelease behavior. This observer never updates any baseline.
    return flow;
}

function checkSnapshot(checks, binding) {
    assert.ok(Array.isArray(checks), 'Missing review checks');
    const primary = checks.filter(
        (check) => check.system === 'ci' && ['build', 'configure', 'tests'].includes(check.type),
    );
    assert.ok(primary.length >= 3, 'Document-check badge is not discovered yet');
    const ids = [...new Set(primary.map((check) => String(check.system_check_id || '')))];
    assert.equal(ids.length, 1);
    assert.match(ids[0], /^[1-9][0-9]*$/);
    if (binding.badgeId) assert.equal(ids[0], binding.badgeId, 'Document-check badge changed');
    const required = checks.filter(
        (check) =>
            check.required === true &&
            check.system !== 'arcanum' &&
            !(
                check.system === 'CI' &&
                check.status === 'action_required' &&
                check.description === 'Waiting for publish'
            ),
    );
    const failed = [...primary, ...required].some((check) =>
        ['failure', 'error', 'cancelled'].includes(check.status),
    );
    const green =
        primary.every((check) => check.status === 'success') &&
        required.every((check) => ['success', 'skipped'].includes(check.status));
    return {
        badgeId: ids[0],
        failed,
        green,
        waitingForStart: primary.some((check) =>
            ['action_required', 'unknown', 'skipped'].includes(check.status),
        ),
    };
}

async function inspectInternal(candidate, check, binding, env, fetcher = boundedFetch) {
    const config = settings(env.DEPENDENCY_TRAIN_INTERNAL);
    const link = await flowLink(check, config, fetcher);
    if (!link) return {state: 'waiting-for-internal-preparation'};
    if (binding.flowUrl) assert.equal(binding.flowUrl, link.url, 'Internal flow changed');
    binding.flowUrl = link.url;
    const rawFlow = await ciRead(
        'LaunchService/GetFlowLaunch',
        {...link, url: undefined, include_flow_vars: true, include_task_execution: true},
        config,
        env.TRAIN_CI_TOKEN,
        fetcher,
    );
    const flow = boundFlow(rawFlow, candidate);

    // A green downstream badge alone cannot prove that its workspace install
    // retained the candidate versions. Require the trusted builder's proof.
    if (!binding.payloadVerified) {
        for (const jobId of ['publish-pr', 'release']) {
            if (!flow.jobs?.[jobId]) continue;
            const details = await ciRead(
                'JobLaunchService/GetJobLaunch',
                {
                    launch_id: link.launch_id,
                    job_id: jobId,
                },
                config,
                env.TRAIN_CI_TOKEN,
                fetcher,
            );
            const badges = details.task_badges || details.taskBadges || [];
            const urls = badges.flatMap((item) => {
                const url = new URL(item.url);
                if (url.origin !== config.artifactOrigin) return [];
                if (url.pathname.endsWith('/dependency-train-proof.json')) return [url.href];
                if (
                    (item.module_name || item.moduleName) === 'ARCADIA' &&
                    url.pathname.endsWith('/index.html')
                ) {
                    return [new URL('dependency-train-proof.json', url).href];
                }
                return [];
            });
            if (!urls.length) continue;
            let response;
            for (const url of urls) {
                response = await fetcher(url);
                if (response.status !== 404) break;
            }
            if (!response || response.status === 404) continue;
            assert.ok(response.status < 300, 'Installed-proof artifact redirected');
            const proof = await response.json();
            assert.equal(proof.schema, 1);
            assert.equal(proof.trainId, candidate.plan.id);
            assert.equal(proof.cliSha, candidate.sha);
            assert.equal(proof.verified, true);
            assert.equal(proof.payloadSha256, candidate.payloadSha256);
            binding.payloadVerified = true;
            break;
        }
        if (!binding.payloadVerified) return {state: 'waiting-for-builder-version-proof'};
    }

    if (!binding.reviewNumber) {
        for (const jobId of ['publish-pr', 'release']) {
            const job = flow.jobs?.[jobId];
            if (!job || !['JOB_STATUS_SUCCESS', 4].includes(job.status)) continue;
            const details = await ciRead(
                'JobLaunchService/GetJobLaunch',
                {
                    launch_id: link.launch_id,
                    job_id: jobId,
                },
                config,
                env.TRAIN_CI_TOKEN,
                fetcher,
            );
            const badges = details.task_badges || details.taskBadges || [];
            for (const badge of badges.filter(
                (item) => (item.module_name || item.moduleName) === 'ARCADIA',
            )) {
                const resource = new URL(badge.url);
                assert.equal(resource.origin, config.artifactOrigin);
                const response = await fetcher(resource.href);
                assert.ok(response.status < 300, 'Review-link artifact redirected');
                const html = await response.text();
                assert.ok(html.length < 64 * 1024);
                const numbers = new Set();
                for (const raw of html.match(/https:\/\/[^\s<>"']+/g) || []) {
                    const url = new URL(raw);
                    const match = /^\/review\/([1-9][0-9]*)\/?$/.exec(url.pathname);
                    if (url.origin === config.reviewUiOrigin && match)
                        numbers.add(Number(match[1]));
                }
                assert.equal(numbers.size, 1, 'Ambiguous generated review link');
                binding.reviewNumber = [...numbers][0];
            }
            if (binding.reviewNumber) break;
        }
    }
    if (!binding.reviewNumber) return {state: 'waiting-for-generated-review'};
    const number = binding.reviewNumber;
    const active = await reviewRead(
        `/v1/pull-requests/${number}/active-diff?fields=commit_ids(base,merge),id`,
        config,
        env.TRAIN_REVIEW_TOKEN,
        fetcher,
    );
    assert.ok(Number.isSafeInteger(active.id) && active.id > 0);
    assert.match(active.commit_ids?.merge, SHA);
    if (binding.diffId) {
        assert.equal(active.id, binding.diffId, 'Generated review diff changed');
        assert.equal(
            active.commit_ids.merge,
            binding.mergeSha,
            'Generated review revision changed',
        );
    }
    Object.assign(binding, {diffId: active.id, mergeSha: active.commit_ids.merge});
    const meta = await reviewRead(
        `/v1/review-requests/${number}?fields=id,ci_checks_button`,
        config,
        env.TRAIN_REVIEW_TOKEN,
        fetcher,
    );
    assert.equal(meta.id, number);
    const checks = await reviewRead(
        `/v1/review-requests/${number}/diff-sets/${active.id}/checks`,
        config,
        env.TRAIN_REVIEW_TOKEN,
        fetcher,
    );
    let snapshot;
    try {
        snapshot = checkSnapshot(checks, binding);
    } catch (error) {
        if (!String(error.message).includes('not discovered yet')) throw error;
        return {
            state: 'waiting-for-manual-start',
            manualStartUrl: `${config.reviewUiOrigin}/review/${number}/merge-checks`,
        };
    }
    binding.badgeId = snapshot.badgeId;
    return {
        state: snapshot.failed
            ? 'failed'
            : snapshot.green
              ? 'documents-passed'
              : snapshot.waitingForStart || meta.ci_checks_button?.status === 'available'
                ? 'waiting-for-manual-start'
                : 'checking-documents',
        manualStartUrl: `${config.reviewUiOrigin}/review/${number}/merge-checks`,
        ...snapshot,
    };
}

module.exports = {
    settings,
    flowLink,
    ciRead,
    reviewRead,
    boundFlow,
    checkSnapshot,
    inspectInternal,
};
