const { test } = require('node:test');
const assert = require('node:assert/strict');
const { clampCodeNumCtx, resolveCodeNumCtx } = require('../src/code/loop/contextWindow.js');

test('uses the loaded window when the model has room (8k -> loaded 24k)', () => {
    assert.equal(clampCodeNumCtx(8192, 24576), 24576);
});

test('never requests more than the model has loaded (loaded 8k stays 8k)', () => {
    assert.equal(clampCodeNumCtx(8192, 8192), 8192);
    assert.equal(clampCodeNumCtx(16384, 8192), 8192);
});

test('caps very large windows for inference speed (loaded 128k -> 32k)', () => {
    assert.equal(clampCodeNumCtx(8192, 131072), 32768);
});

test('honors a higher requested slider, within the loaded window', () => {
    assert.equal(clampCodeNumCtx(20000, 24576), 24576);
});

test('floors small loaded windows to themselves (loaded 12k -> 12k, never above loaded)', () => {
    assert.equal(clampCodeNumCtx(8192, 12288), 12288);
});

test('unknown loaded window -> respect the request (no over-packing)', () => {
    assert.equal(clampCodeNumCtx(8192, null), 8192);
    assert.equal(clampCodeNumCtx(8192, 0), 8192);
    assert.equal(clampCodeNumCtx(undefined, null), 8192);
});

test('resolveCodeNumCtx falls back to the request when the backend is unreachable', async () => {
    const { numCtx, loadedContext } = await resolveCodeNumCtx(8192, 'http://127.0.0.1:59999', 'nope');
    assert.equal(loadedContext, null);
    assert.equal(numCtx, 8192);
});
