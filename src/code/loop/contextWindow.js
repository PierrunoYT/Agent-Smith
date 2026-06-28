/**
 * Code Mode context-window policy.
 *
 * Code Mode builds multi-file apps. At a small context the model loses track across files —
 * kebab/camel id drift, "x is not a function" cross-module bugs, dropped requirements. Real
 * builds confirmed this: the SAME budget-tracker task that failed at 8192 ctx passed cleanly
 * once the window was raised. So Code Mode should use the model's loaded context window rather
 * than the shared 8192 default.
 *
 * IMPORTANT: never request MORE than the model is actually loaded with. Over-requesting makes
 * the harness pack more history than the backend can hold, and the backend then silently
 * truncates the prompt — worse than a small-but-honest window. We read the loaded window from
 * LM Studio's native endpoint and clamp to it; on any other backend we respect the request.
 *
 * Code Mode only — Chat/Agent pass the slider value straight through and are unaffected.
 */
'use strict';

const CODE_MIN_NUM_CTX = Number(process.env.XK_CODE_MIN_NUM_CTX) || 16384;
const CODE_MAX_NUM_CTX = Number(process.env.XK_CODE_MAX_NUM_CTX) || 32768;

/** Best-effort read of the loaded model's context window (LM Studio native API). null if unknown. */
async function fetchLoadedContext(apiBaseUrl, model) {
    if (!apiBaseUrl || typeof fetch !== 'function') return null;
    const base = String(apiBaseUrl).replace(/\/+$/, '').replace(/\/v1$/, '');
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 2000);
        let res;
        try {
            res = await fetch(`${base}/api/v0/models`, { signal: ctrl.signal });
        } finally {
            clearTimeout(timer);
        }
        if (!res || !res.ok) return null;
        const json = await res.json();
        const list = Array.isArray(json?.data) ? json.data : (Array.isArray(json) ? json : []);
        const match = list.find(m => m?.id === model && m?.loaded_context_length)
            || list.find(m => m?.state === 'loaded' && m?.loaded_context_length)
            || list.find(m => m?.loaded_context_length);
        const n = match && Number(match.loaded_context_length);
        return Number.isFinite(n) && n > 0 ? n : null;
    } catch (e) {
        return null;
    }
}

/**
 * Pure policy: prefer the loaded window (capped for inference speed), but at least the floor
 * and at least the caller's requested value — and NEVER above what the model has loaded.
 * When the loaded window is unknown, respect the requested value (no over-packing risk).
 */
function clampCodeNumCtx(requested, loadedContext) {
    const req = Number(requested) || 8192;
    if (!loadedContext || loadedContext <= 0) return req;
    let n = Math.min(loadedContext, CODE_MAX_NUM_CTX);           // prefer loaded window, capped
    n = Math.max(n, Math.min(req, loadedContext));               // honor a higher slider/request
    n = Math.max(n, Math.min(CODE_MIN_NUM_CTX, loadedContext));  // ensure the floor (within the model)
    return Math.min(n, loadedContext);
}

/** Resolve the num_ctx a Code Mode run should request, reading the backend when possible. */
async function resolveCodeNumCtx(requested, apiBaseUrl, model) {
    const loadedContext = await fetchLoadedContext(apiBaseUrl, model);
    return { numCtx: clampCodeNumCtx(requested, loadedContext), loadedContext };
}

module.exports = {
    resolveCodeNumCtx,
    clampCodeNumCtx,
    fetchLoadedContext,
    CODE_MIN_NUM_CTX,
    CODE_MAX_NUM_CTX
};
