const { test } = require('node:test');
const assert = require('node:assert/strict');

const { executeAgentToolBatch, firePluginHook } = require('../src/renderer/modes/chatLoop.js');

test('firePluginHook returns timeout result instead of hanging', async () => {
    const api = { invoke: () => new Promise(() => {}) };
    const res = await firePluginHook(api, 'beforeToolCall', {}, 5);
    assert.equal(res.timedOut, true);
    assert.match(res.error, /timed out/);
});

test('executeAgentToolBatch emits timeout result and continues', async () => {
    const events = [];
    const calls = [{ id: 'c1', function: { name: 'slow_tool', arguments: {} } }];
    const results = await executeAgentToolBatch(calls, {
        api: { invoke: async () => null },
        toolTimeoutMs: 5,
        hookTimeoutMs: 5,
        emitAgentEvent: ev => events.push(ev),
        executeTool: () => new Promise(() => {})
    });

    assert.equal(results.length, 1);
    assert.match(results[0].result, /timed out/);
    const resultEvent = events.find(ev => ev.type === 'tool_result');
    assert.equal(resultEvent.ok, false);
    assert.match(resultEvent.result.output, /timed out/);
});
