/**
 * Agent chat loop helpers — tool batch execution + timeline events.
 */
(function (global) {
    'use strict';

    function withTimeout(promise, ms, label, controller) {
        let timer;
        const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => {
                if (controller) { try { controller.abort(); } catch (e) { /* ignore */ } }
                reject(new Error(`${label} timed out after ${ms}ms`));
            }, ms);
        });
        return Promise.race([
            Promise.resolve(promise).finally(() => clearTimeout(timer)),
            timeoutPromise
        ]);
    }

    async function firePluginHook(api, event, payload, timeoutMs = 10000) {
        if (!api) return null;
        try {
            return await withTimeout(api.invoke('plugin-fire-hook', { hookEvent: event, payload: payload || {} }), timeoutMs, `Plugin hook ${event}`);
        } catch (e) {
            return { error: e.message || String(e), timedOut: /timed out/i.test(e.message || '') };
        }
    }

    async function executeAgentToolBatch(validToolCalls, deps) {
        const results = [];
        const emit = deps.emitAgentEvent || (() => {});

        for (const t of validToolCalls) {
            const toolId = t.id || `tool_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            const name = t.function.name;
            const args = t.function.arguments;

            emit({ type: 'tool_start', name, args, callId: toolId });

            const hookTimeoutMs = deps.hookTimeoutMs || 10000;
            const toolTimeoutMs = deps.toolTimeoutMs || 300000;
            const before = await firePluginHook(deps.api, 'beforeToolCall', { tool: name, name, args }, hookTimeoutMs);
            if (before?.timedOut) {
                const timeout = `Error: ${before.error}`;
                emit({ type: 'tool_result', name, ok: false, result: { error: timeout, timedOut: true }, callId: toolId, durationMs: 0 });
                results.push({ tool: t, result: timeout, toolId });
                continue;
            }
            if (before?.blocked) {
                const blocked = `[BLOCKED] ${before.reason || 'plugin hook'}`;
                emit({ type: 'tool_result', name, ok: false, result: { error: blocked }, callId: toolId, durationMs: 0 });
                results.push({ tool: t, result: blocked, toolId });
                continue;
            }

            const startTool = Date.now();
            let result;
            try {
                if (deps.executeTool) {
                    const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
                    result = await withTimeout(deps.executeTool(name, args, deps, { signal: controller?.signal }), toolTimeoutMs, `Tool ${name}`, controller);
                } else {
                    result = 'Error: executeTool not provided';
                }
                if (deps.trace) {
                    deps.trace.addStep('tools.execute', 'tools', 'ok', 'TOOL_OK', Date.now() - startTool, name, name);
                }
            } catch (e) {
                result = `Error: ${e.message}`;
                if (deps.trace) {
                    deps.trace.addStep('tools.execute', 'tools', 'error', 'TOOL_ERR', Date.now() - startTool, e.message, name);
                }
            }

            const after = await firePluginHook(deps.api, 'afterToolCall', { tool: name, name, args, result }, hookTimeoutMs);
            if (after?.timedOut && deps.trace) {
                deps.trace.addStep('tools.hook', 'tools', 'error', 'HOOK_TIMEOUT', Date.now() - startTool, after.error, name);
            }

            const ok = !String(result).startsWith('Error:') && !String(result).startsWith('[BLOCKED]');
            emit({
                type: 'tool_result',
                name,
                ok,
                result: typeof result === 'string' ? { output: result } : result,
                callId: toolId,
                durationMs: Date.now() - startTool
            });
            results.push({ tool: t, result: String(result), toolId });
        }
        return results;
    }

    const api = { executeAgentToolBatch, firePluginHook, withTimeout };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') window.XKChatLoop = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
