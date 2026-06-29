/**
 * WhatsApp is an OPTIONAL feature (its deps pull puppeteer/Chromium, which is why a lean
 * install omits them). Registering its IPC must never throw at load/registration time, and
 * the channels must still register so the renderer's invokes resolve — only USING WhatsApp
 * without the optional deps should return a friendly error. This locks the "lean install
 * still boots" guarantee the README leans on.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const registerWhatsAppIpc = require('../src/main/lifecycle/whatsapp.js');

test('registerWhatsAppIpc registers channels without throwing (deps present or not)', () => {
    const handlers = new Map();
    const ipcMain = { handle: (name, fn) => handlers.set(name, fn) };
    assert.doesNotThrow(() => registerWhatsAppIpc(ipcMain, () => null, { getPath: () => '.' }, () => {}));
    assert.ok(handlers.has('whatsapp-init'), 'whatsapp-init registered');
    assert.ok(handlers.has('whatsapp-send'), 'whatsapp-send registered');
});

test('whatsapp-send before init returns an error instead of throwing', async () => {
    const handlers = new Map();
    registerWhatsAppIpc({ handle: (n, fn) => handlers.set(n, fn) }, () => null, { getPath: () => '.' }, () => {});
    const res = await handlers.get('whatsapp-send')({}, { number: '1', message: 'hi' });
    assert.ok(res && res.error, 'returns a structured error, not a throw');
});

test('whatsapp-init destroys failed client and allows retry', async () => {
    const realLoad = Module._load;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-test-'));
    const chrome = path.join(tmp, process.platform === 'win32' ? 'chrome.exe' : 'chrome');
    fs.writeFileSync(chrome, '');
    const savedChrome = process.env.CHROME_PATH;
    process.env.CHROME_PATH = chrome;
    delete require.cache[require.resolve('../src/main/lifecycle/whatsapp.js')];
    let initCalls = 0;
    let destroyCalls = 0;
    class Client {
        on() {}
        async initialize() { initCalls++; throw new Error('init failed'); }
        async destroy() { destroyCalls++; }
    }
    Module._load = function (request) {
        if (request === 'whatsapp-web.js') return { Client, LocalAuth: class LocalAuth { constructor(opts) { this.opts = opts; } } };
        if (request === 'qrcode') return { toDataURL: async () => 'data:' };
        if (request === 'puppeteer') throw new Error('no bundled browser');
        return realLoad.apply(this, arguments);
    };
    try {
        const freshRegister = require('../src/main/lifecycle/whatsapp.js');
        const handlers = new Map();
        freshRegister({ handle: (n, fn) => handlers.set(n, fn) }, () => null, { getPath: () => tmp }, () => {});
        assert.match((await handlers.get('whatsapp-init')({})).error, /init failed/);
        assert.match((await handlers.get('whatsapp-init')({})).error, /init failed/);
        assert.equal(initCalls, 2, 'retry should create and initialize a fresh client');
        assert.equal(destroyCalls, 2, 'failed clients are destroyed');
    } finally {
        Module._load = realLoad;
        delete require.cache[require.resolve('../src/main/lifecycle/whatsapp.js')];
        if (savedChrome === undefined) delete process.env.CHROME_PATH;
        else process.env.CHROME_PATH = savedChrome;
    }
});
