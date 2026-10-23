'use strict';

/** Shared JSON transport for the small GitHub audit CLIs. */
async function githubRequest(token, method, route, body, userAgent = 'diplodoc-infra') {
    const options = {
        method: method || 'GET',
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': userAgent,
        },
    };
    if (body !== undefined) {
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(body);
    }

    const response = await fetch(`https://api.github.com${route}`, options);
    const text = await response.text();
    let json = null;
    if (text) {
        try {
            json = JSON.parse(text);
        } catch {
            if (response.ok) {
                const error = new Error(`Invalid JSON from GitHub API ${options.method} ${route}`);
                error.status = response.status;
                throw error;
            }
        }
    }

    return {ok: response.ok, status: response.status, json};
}

/** GET JSON, retaining HTTP status so callers can distinguish optional 404s. */
async function githubData(token, route, userAgent) {
    const result = await githubRequest(token, 'GET', route, undefined, userAgent);
    if (!result.ok) {
        const detail = result.json && result.json.message;
        const error = new Error(
            `GitHub API GET ${route} -> ${result.status}${detail ? `: ${detail}` : ''}`,
        );
        error.status = result.status;
        throw error;
    }

    return result.json;
}

module.exports = {githubRequest, githubData};
