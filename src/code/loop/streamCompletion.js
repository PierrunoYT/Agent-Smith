/**
 * LLM streaming completion for Code Mode (OpenAI /v1/chat/completions).
 */
'use strict';

const https = require('https');
const http = require('http');
const { normalizeLlmBaseUrl } = require('../../shared/netGuard.js');
const { tryParseJson } = require('../tools/jsonRepair.js');
const { stripInlineReasoning } = require('./reasoningStrip.js');
const { buildToolResponseFormat, parseConstrainedContent } = require('./constrainTools.js');

function apiBase(base) {
    return normalizeLlmBaseUrl(base);
}

function messagesForWire(messages) {
    return (messages || []).map(message => {
        if (!Array.isArray(message?.tool_calls)) return message;
        return {
            ...message,
            tool_calls: message.tool_calls.map(call => ({
                ...call,
                function: {
                    ...call.function,
                    arguments: typeof call.function?.arguments === 'string'
                        ? call.function.arguments
                        : JSON.stringify(call.function?.arguments || {})
                }
            }))
        };
    });
}

async function streamCompletion({
    apiBaseUrl, model, messages, tools, signal, onDelta, maxTokens, temperature,
    requestTimeoutMs = 300000, inactivityTimeoutMs = 60000, constrain = false
}) {
    const url = `${apiBase(apiBaseUrl)}/v1/chat/completions`;
    // Send an EXPLICIT positive max_tokens. max_tokens:-1 is mishandled by several servers
    // (treated as a small default ~512), which silently caps every reply — so files larger
    // than the cap (e.g. a full script.js) are truncated no matter how big the context is.
    // A concrete budget gives the model room to emit a whole source file.
    const cap = Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : 4096;
    const body = {
        model,
        messages: messagesForWire(messages),
        stream: true,
        temperature: Number.isFinite(temperature) ? temperature : 0.2,
        max_tokens: cap
    };
    // Constrained tool-call decoding (opt-in): instead of native function-calling, send the
    // tools as an LM Studio json_schema response_format so the model can only emit a valid
    // {name, arguments} object. The reply arrives as JSON content, parsed below.
    const responseFormat = constrain && tools && tools.length ? buildToolResponseFormat(tools) : null;
    if (responseFormat) {
        body.response_format = responseFormat;
    } else if (tools && tools.length) {
        body.tools = tools;
    }

    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(body);

    return new Promise((resolve, reject) => {
        let hardTimer = null;
        let idleTimer = null;
        let settled = false;
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(hardTimer);
            clearTimeout(idleTimer);
            fn(value);
        };
        const armIdleTimer = (req) => {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                req.destroy(new Error(`LM Studio response stalled for ${inactivityTimeoutMs}ms`));
            }, inactivityTimeoutMs);
        };
        const req = lib.request({
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        }, (res) => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
                let errorBody = '';
                res.setEncoding('utf8');
                res.on('data', chunk => { errorBody += chunk; });
                res.on('end', () => {
                    let detail = errorBody.trim();
                    try {
                        const parsedError = JSON.parse(errorBody);
                        detail = parsedError?.error?.message || parsedError?.message || detail;
                    } catch (e) { /* keep raw body */ }
                    if (/failed to load model|model.*not found|no models? loaded/i.test(detail)) {
                        return finish(reject, new Error(`Model "${model}" failed to load in LM Studio: ${detail}. Pick a model that loads (check available VRAM) and retry.`));
                    }
                    finish(reject, new Error(`LM Studio HTTP ${res.statusCode}: ${detail || res.statusMessage || 'request failed'}`));
                });
                return;
            }
            let buffer = '';
            let content = '';
            let toolCalls = [];
            let finishReason = null;
            let sawReasoning = false;

            res.on('data', (chunk) => {
                armIdleTimer(req);
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith('data:')) continue;
                    const data = trimmed.slice(5).trim();
                    if (data === '[DONE]') continue;
                    let json;
                    try { json = JSON.parse(data); } catch (e) { continue; }
                    const delta = json.choices?.[0]?.delta;
                    if (!delta) continue;
                    if (delta.content) {
                        content += delta.content;
                        if (onDelta) onDelta(delta.content);
                    }
                    // Surface reasoning-model thinking (delta.reasoning_content) to the
                    // timeline's "Reasoning" panel. Display-only — NOT added to `content`,
                    // so it isn't re-sent to the model. Without this, Code Mode looks frozen
                    // while a reasoning model (qwen3 etc.) thinks, and reasoning never traces.
                    // Some servers use `reasoning_content`, others `reasoning`.
                    const reasoningDelta = delta.reasoning_content || delta.reasoning;
                    if (reasoningDelta) {
                        sawReasoning = true;
                        if (onDelta) onDelta(reasoningDelta);
                    }
                    if (delta.tool_calls) {
                        for (const tc of delta.tool_calls) {
                            const idx = tc.index ?? 0;
                            if (!toolCalls[idx]) {
                                toolCalls[idx] = { id: tc.id || `call_${idx}`, type: 'function', function: { name: '', arguments: '' } };
                            }
                            if (tc.id) toolCalls[idx].id = tc.id;
                            if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
                            if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
                        }
                    }
                    if (json.choices?.[0]?.finish_reason) finishReason = json.choices[0].finish_reason;
                }
            });

            res.on('end', () => {
                toolCalls = toolCalls.filter(Boolean).map(tc => {
                    const r = tryParseJson(tc.function.arguments);
                    const args = r.ok && r.value && typeof r.value === 'object' ? r.value : {};
                    return { id: tc.id, type: 'function', function: { name: tc.function.name, arguments: args } };
                });
                // Strip inline <think>...</think> reasoning that some small models emit
                // in content (vs the reasoning_content field) so it never reaches the
                // edit/tool parser. Flag it so the reasoning-truncation guard still fires.
                const stripped = stripInlineReasoning(content);
                if (stripped.hadReasoning) sawReasoning = true;

                // Constrained decoding: the reply IS the tool call (JSON content), not a
                // native tool_calls array. Parse it. A "finish" choice becomes a normal
                // no-tool-call turn (content = summary) so the completion gate runs.
                if (responseFormat) {
                    const c = parseConstrainedContent(stripped.text);
                    finish(resolve, {
                        message: {
                            role: 'assistant',
                            content: c.finish ? (c.summary || '') : '',
                            tool_calls: c.toolCalls.length ? c.toolCalls : undefined
                        },
                        finishReason,
                        sawReasoning
                    });
                    return;
                }

                finish(resolve, {
                    message: { role: 'assistant', content: stripped.text, tool_calls: toolCalls.length ? toolCalls : undefined },
                    finishReason,
                    sawReasoning
                });
            });
        });

        hardTimer = setTimeout(() => {
            req.destroy(new Error(`LM Studio request timed out after ${requestTimeoutMs}ms`));
        }, requestTimeoutMs);
        armIdleTimer(req);
        req.on('error', error => finish(reject, error));
        if (signal) {
            if (signal.aborted) {
                req.destroy();
                return finish(reject, new Error('Aborted'));
            }
            signal.addEventListener('abort', () => {
                req.destroy();
                finish(reject, new Error('Aborted'));
            }, { once: true });
        }
        req.write(payload);
        req.end();
    });
}

module.exports = { streamCompletion, apiBase };
