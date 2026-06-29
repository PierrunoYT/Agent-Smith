/**
 * Local LM Studio model configuration.
 *
 * Context length is fixed when a model is loaded. This manager keeps Agent Smith's
 * context setting aligned with the real loaded instance for loopback LM Studio only.
 */
'use strict';

const http = require('http');
const https = require('https');
const { execFile: nodeExecFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FALLBACK_CONTEXTS = [
    131072, 98304, 65536, 49152, 32768, 24576, 16384, 12288, 8192, 4096
];

function isLoopbackApiBase(apiBaseUrl) {
    try {
        const hostname = new URL(apiBaseUrl).hostname.toLowerCase();
        return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
    } catch (e) {
        return false;
    }
}

function buildContextCandidates(requested, maxContext) {
    const max = Math.max(4096, Math.floor(Number(maxContext) || 4096));
    const wanted = Math.min(max, Math.max(4096, Math.floor(Number(requested) || 4096)));
    return [...new Set([wanted, ...FALLBACK_CONTEXTS])]
        .filter(n => n <= wanted && n <= max && n >= 4096)
        .sort((a, b) => b - a);
}

function managementUrl(apiBaseUrl) {
    const url = new URL(apiBaseUrl);
    url.pathname = '/api/v1/models';
    url.search = '';
    url.hash = '';
    return url.toString();
}

function defaultRequestJson(url, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const lib = parsed.protocol === 'https:' ? https : http;
        const req = lib.get(parsed, { timeout: timeoutMs }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    return reject(new Error(`LM Studio API returned ${res.statusCode}`));
                }
                try {
                    resolve(JSON.parse(body));
                } catch (e) {
                    reject(new Error(`Invalid LM Studio API response: ${e.message}`));
                }
            });
        });
        req.on('timeout', () => req.destroy(new Error('LM Studio API request timed out')));
        req.on('error', reject);
    });
}

function defaultExecFile(file, args) {
    return new Promise((resolve, reject) => {
        nodeExecFile(file, args, { windowsHide: true, timeout: 180000 }, (error, stdout, stderr) => {
            if (error) {
                error.stdout = stdout || '';
                error.stderr = stderr || '';
                reject(error);
                return;
            }
            resolve({ stdout: stdout || '', stderr: stderr || '' });
        });
    });
}

function defaultLmsPath() {
    const exe = process.platform === 'win32' ? 'lms.exe' : 'lms';
    const bundled = path.join(os.homedir(), '.lmstudio', 'bin', exe);
    return fs.existsSync(bundled) ? bundled : 'lms';
}

function findModel(payload, model) {
    const models = Array.isArray(payload?.models) ? payload.models : [];
    return models.find(item =>
        item?.key === model ||
        (item?.loaded_instances || []).some(instance => instance?.id === model)
    ) || null;
}

function statusFromModel(item, model) {
    const instances = Array.isArray(item?.loaded_instances) ? item.loaded_instances : [];
    const loaded = instances.find(instance => instance?.id === model) || instances[0] || null;
    return {
        managed: true,
        model,
        loadedContext: loaded?.config?.context_length || null,
        maxContext: item?.max_context_length || loaded?.config?.context_length || 4096,
        parallel: loaded?.config?.parallel || null
    };
}

function createLmStudioManager(deps = {}) {
    const requestJson = deps.requestJson || defaultRequestJson;
    const execFile = deps.execFile || defaultExecFile;
    const lmsPath = deps.lmsPath || defaultLmsPath();
    let operation = Promise.resolve();

    async function getStatus({ apiBaseUrl, model }) {
        if (!isLoopbackApiBase(apiBaseUrl)) {
            return { managed: false, reason: 'remote_endpoint' };
        }
        let payload;
        try {
            payload = await requestJson(managementUrl(apiBaseUrl));
        } catch (e) {
            return { managed: false, reason: 'lmstudio_unavailable', warning: e.message };
        }
        const item = findModel(payload, model);
        if (!item) {
            return { managed: false, reason: 'model_not_found', model };
        }
        return statusFromModel(item, model);
    }

    async function ensureNow({ apiBaseUrl, model, contextLength }) {
        const before = await getStatus({ apiBaseUrl, model });
        if (!before.managed) return before;

        const requestedContext = Math.min(
            before.maxContext,
            Math.max(4096, Math.floor(Number(contextLength) || 4096))
        );
        if (before.loadedContext === requestedContext && before.parallel === 1) {
            return {
                ...before,
                requestedContext,
                fallbackUsed: false,
                reloaded: false,
                warning: null
            };
        }

        const candidates = buildContextCandidates(requestedContext, before.maxContext);
        let selected = null;
        let lastError = null;
        for (const candidate of candidates) {
            const estimateArgs = [
                'load', model,
                '--context-length', String(candidate),
                '--parallel', '1',
                '--gpu', 'max',
                '--estimate-only',
                '-y'
            ];
            try {
                await execFile(lmsPath, estimateArgs);
                selected = candidate;
                break;
            } catch (e) {
                lastError = e;
            }
        }
        if (!selected) {
            return {
                ...before,
                requestedContext,
                error: lastError?.stderr || lastError?.message || 'No context size could be loaded'
            };
        }

        if (before.loadedContext != null) {
            try {
                await execFile(lmsPath, ['unload', model]);
            } catch (e) {
                const msg = String(e?.stderr || e?.message || '');
                if (!/not loaded|not found/i.test(msg)) throw e;
            }
        }
        // Load the replacement, and on failure attempt to restore the previously
        // loaded instance so the user is not left with no working model. Previously
        // an error here propagated after the unload, leaving nothing loaded.
        try {
            await execFile(lmsPath, [
                'load', model,
                '--context-length', String(selected),
                '--parallel', '1',
                '--gpu', 'max',
                '--identifier', model,
                '-y'
            ]);
        } catch (e) {
            if (before.loadedContext != null) {
                try {
                    await execFile(lmsPath, [
                        'load', model,
                        '--context-length', String(before.loadedContext),
                        '--parallel', String(before.parallel || 1),
                        '--gpu', 'max',
                        '--identifier', model,
                        '-y'
                    ]);
                } catch (e2) { /* best-effort rollback; report the original failure */ }
            }
            return {
                ...before,
                requestedContext,
                error: `LM Studio load failed: ${e?.stderr || e?.message || 'unknown error'}${before.loadedContext != null ? ' (restored previous context)' : ''}`
            };
        }

        const after = await getStatus({ apiBaseUrl, model });
        if (!after.managed || after.loadedContext !== selected) {
            return {
                ...after,
                requestedContext,
                error: `LM Studio did not confirm context ${selected}`
            };
        }
        const fallbackUsed = selected !== requestedContext;
        return {
            ...after,
            requestedContext,
            fallbackUsed,
            reloaded: true,
            warning: fallbackUsed
                ? `Requested context ${requestedContext} could not load; using ${selected}.`
                : null
        };
    }

    function ensureModel(opts) {
        const next = operation.then(() => ensureNow(opts), () => ensureNow(opts));
        operation = next.catch(() => {});
        return next;
    }

    return { getStatus, ensureModel };
}

module.exports = {
    FALLBACK_CONTEXTS,
    isLoopbackApiBase,
    buildContextCandidates,
    defaultLmsPath,
    createLmStudioManager
};
