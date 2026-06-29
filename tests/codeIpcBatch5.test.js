'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const Module = require('module');

function fakeIpc() {
    const handlers = new Map();
    return { ipcMain: { handle: (n, fn) => handlers.set(n, fn) }, h: n => handlers.get(n) };
}

function loadCodeIpcWith(runCodeTask) {
    const realLoad = Module._load;
    delete require.cache[require.resolve('../src/main/ipc/code.js')];
    Module._load = function (request) {
        if (String(request).includes('runCodeTask.js')) return { runCodeTask };
        return realLoad.apply(this, arguments);
    };
    try {
        return require('../src/main/ipc/code.js');
    } finally {
        Module._load = realLoad;
        delete require.cache[require.resolve('../src/main/ipc/code.js')];
    }
}

function deps(extra = {}) {
    return {
        spawn: () => new EventEmitter(),
        exec: () => {},
        projectContext: {
            getRoot: () => '/ROOT',
            setRoot: () => {},
            getShellConfig: () => ({ shell: 'sh', flag: '-c', commandFlag: '-Command' }),
            isWindows: () => false
        },
        editEngine: {},
        changeLedger: {},
        grepProject: async () => ({ hits: [] }),
        globFiles: async () => ({ files: [] }),
        relPathFromRoot: p => p,
        userDataPath: '/UD',
        getLmsUrl: () => 'http://127.0.0.1:1234',
        getMainWindow: () => null,
        pushEvent: () => {},
        pluginManager: null,
        memoryManager: null,
        previewRunner: null,
        ...extra
    };
}

test('code-run forwards isolation and milestone flags into runCodeTask', async () => {
    let captured;
    const registerCodeIpc = loadCodeIpcWith(async (opts) => {
        captured = opts;
        return { id: 'sess', status: 'done' };
    });
    const { ipcMain, h } = fakeIpc();
    registerCodeIpc(ipcMain, deps());

    const res = await h('code-run')({}, {
        prompt: 'build',
        model: 'qwen',
        isolatedRun: true,
        parallelMilestones: true,
        milestoneWorktrees: true,
        milestoneConcurrent: true
    });

    assert.equal(res.success, true);
    assert.equal(captured.isolatedRun, true);
    assert.equal(captured.parallelMilestones, true);
    assert.equal(captured.milestoneWorktrees, true);
    assert.equal(captured.milestoneConcurrent, true);
});

test('code background command attaches child error handler', async () => {
    let child;
    const registerCodeIpc = loadCodeIpcWith(async (opts) => {
        const execDeps = opts.buildExecDeps('sess');
        const bg = execDeps.runBackgroundCommand('missing-shell-command', '/ROOT');
        assert.equal(bg.jobId, 1);
        return { id: 'sess', status: 'done' };
    });
    const { ipcMain, h } = fakeIpc();
    registerCodeIpc(ipcMain, deps({
        spawn: () => {
            child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            return child;
        }
    }));

    await h('code-run')({}, { prompt: 'build', model: 'qwen' });
    assert.ok(child.listenerCount('error') > 0, 'spawned child has an error handler');
    assert.doesNotThrow(() => child.emit('error', new Error('spawn failed')));
});
