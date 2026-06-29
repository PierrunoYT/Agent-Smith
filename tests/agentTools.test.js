/**
 * Agent Mode tool surface — full host control (shell + whole-host file management),
 * matching the "manage everything on this computer" doctrine. Code Mode keeps its
 * own root-contained executor; agent-* tools deliberately reach the whole host.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    AGENT_SYS_TOOLS,
    BUILD_TOOL_NAMES,
    isBuildTool,
    toolsForChatMode,
    extractTextToolCalls
} = require('../src/renderer/modes/agentTools.js');

test('Agent Mode includes full host-management tools (write/delete enabled)', () => {
    const names = new Set(AGENT_SYS_TOOLS.map(t => t.function.name));
    for (const required of ['write_file', 'delete_file', 'read_file', 'list_directory']) {
        assert.ok(names.has(required), `${required} must be available in Agent Mode`);
        assert.equal(isBuildTool(required), false, `${required} must NOT be blocked in Agent Mode`);
    }
});

test('Agent Mode includes shell, read_file, and process management', () => {
    const names = new Set(AGENT_SYS_TOOLS.map(t => t.function.name));
    assert.ok(names.has('run_shell_command'));
    assert.ok(names.has('read_file'));
    assert.ok(names.has('list_directory'));
    // Process management must be advertised, not just implemented in the dispatcher.
    assert.ok(names.has('list_processes'), 'list_processes must be advertised');
    assert.ok(names.has('stop_process'), 'stop_process must be advertised');
});

test('every advertised Agent tool is dispatchable (no schema/handler drift)', () => {
    // Guards the bug where list_processes/stop_process were handled but never advertised.
    const handled = require('fs').readFileSync(require('path').join(__dirname, '../src/renderer/modes/agentTools.js'), 'utf8');
    for (const t of AGENT_SYS_TOOLS) {
        const n = t.function.name;
        assert.ok(handled.includes(`name === '${n}'`) || ['task_begin', 'task_complete', 'memory_purge'].includes(n),
            `advertised tool "${n}" has no dispatch branch`);
    }
});

test('toolsForChatMode returns agent tools only when agent on', () => {
    const agent = toolsForChatMode({ agentEnabled: true, memoryEnabled: true });
    assert.ok(agent.some(t => t.function.name === 'run_shell_command'));
    const mem = toolsForChatMode({ agentEnabled: false, memoryEnabled: true });
    assert.equal(mem.length, 2);
    const none = toolsForChatMode({ agentEnabled: false, memoryEnabled: false });
    assert.equal(none.length, 0);
});

test('Agent Mode advertises web read tools', () => {
    const names = new Set(AGENT_SYS_TOOLS.map(t => t.function.name));
    for (const t of ['web_search', 'fetch_url']) {
        assert.ok(names.has(t), `${t} must be advertised in Agent Mode`);
    }
});

test('extractTextToolCalls recovers mutating JSON tools only from explicit tool fences', () => {
    const known = ['write_file', 'web_search', 'read_file'];
    const prose = 'Example only: {"name": "write_file", "parameters": {"filepath": "a.txt", "content": "Trinity", "append": false}}';
    assert.equal(extractTextToolCalls(prose, known).length, 0);

    const text = 'Sure, I will write the file.\n```tool-call\n{"name": "write_file", "parameters": {"filepath": "a.txt", "content": "Trinity", "append": false}}\n```';
    const calls = extractTextToolCalls(text, known);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'write_file');
    assert.deepEqual(calls[0].arguments, { filepath: 'a.txt', content: 'Trinity', append: false });
    assert.ok(calls[0].raw.includes('write_file'));
});

test('extractTextToolCalls handles nested braces and "arguments" alias, ignores unknown tools', () => {
    const known = ['fetch_url'];
    const text = '{"name":"fetch_url","arguments":{"url":"https://x.io/?a={b}","meta":{"k":1}}} and {"name":"unknown_x","parameters":{}}';
    const calls = extractTextToolCalls(text, known);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'fetch_url');
    assert.equal(calls[0].arguments.url, 'https://x.io/?a={b}');
    assert.deepEqual(calls[0].arguments.meta, { k: 1 });
});

test('extractTextToolCalls returns nothing for plain prose', () => {
    assert.equal(extractTextToolCalls('Just a normal answer with no tools.', ['web_search']).length, 0);
});

test('extractTextToolCalls gates mutating XML recovery but allows read-only JSON recovery', () => {
    assert.equal(extractTextToolCalls('<function=run_shell_command><parameter=command>rm x</parameter></function>', ['run_shell_command']).length, 0);
    const fenced = '```tool\n<function=run_shell_command><parameter=command>echo ok</parameter></function>\n```';
    const calls = extractTextToolCalls(fenced, ['run_shell_command']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].arguments.command, 'echo ok');

    const readOnly = extractTextToolCalls('{"name":"fetch_url","arguments":{"url":"https://example.com"}}', ['fetch_url']);
    assert.equal(readOnly.length, 1);
});

test('Agent Mode never exposes a password-returning credential tool', () => {
    const names = new Set(AGENT_SYS_TOOLS.map(t => t.function.name));
    // The browser/credential-vault feature was removed; ensure no credential tool lingers
    // and the model is never handed a tool that returns a stored password.
    for (const forbidden of ['browser_login', 'vault_list_sites', 'vault_get', 'vault_get_password', 'get_credential']) {
        assert.equal(names.has(forbidden), false, `${forbidden} must NOT be exposed to the agent`);
    }
});

test('BUILD_TOOL_NAMES is empty — Agent Mode blocks nothing (full control)', () => {
    // Doctrine change: Agent Mode manages the whole computer, so no tool is hard-blocked.
    // Safety lives in commandPolicy (shell) and pathPolicy (file mutations), not here.
    assert.equal(BUILD_TOOL_NAMES.size, 0);
    assert.equal(isBuildTool('write_file'), false);
});
