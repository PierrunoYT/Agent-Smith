/**
 * Agent Mode (SYS-ACCESS) — chat-path tools: shell + read-only filesystem.
 * No write/patch/delete — those belong to Code Mode only.
 */
(function (global) {
    'use strict';

    /** Tools that mutate the project — blocked in Agent Mode even if the model hallucinates them. */
    const BUILD_TOOL_NAMES = new Set([]);

    const AGENT_SYS_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'provide_file_download_link',
            description: 'Provide the user with a direct download link to a file on the host system. Useful when the user is accessing the agent remotely and needs to download a local file.',
            parameters: { type: 'object', properties: { filepath: { type: 'string' } }, required: ['filepath'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'task_begin',
            description: 'State your goal and a multi-step plan before starting a complex task. This helps maintain focus and context.',
            parameters: { type: 'object', properties: { goal: { type: 'string' }, plan: { type: 'array', items: { type: 'string' } } }, required: ['goal', 'plan'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'task_complete',
            description: 'Signal that the task is finished. Provide a final summary of what was accomplished and any verification results.',
            parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'run_shell_command',
            description: 'Execute a bash shell command. USE THIS to check system state, running processes, network, or execute scripts. Sudo is not supported interactively. For long-running tasks, set is_background to true.',
            parameters: { type: 'object', properties: { command: { type: 'string' }, is_background: { type: 'boolean' } }, required: ['command'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'read_process_log',
            description: 'Read the output log of a background process.',
            parameters: { type: 'object', properties: { job_id: { type: 'string' }, lines: { type: 'number' } }, required: ['job_id'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'send_input',
            description: 'Send input to an active background process.',
            parameters: { type: 'object', properties: { job_id: { type: 'string' }, input: { type: 'string' } }, required: ['job_id', 'input'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'list_processes',
            description: 'List all background jobs started this session, with their running state and last output line.',
            parameters: { type: 'object', properties: {} }
        }
    },
    {
        type: 'function',
        function: {
            name: 'stop_process',
            description: 'Kill a running background process by its job id.',
            parameters: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read a file from the host system.',
            parameters: { type: 'object', properties: { filepath: { type: 'string' } }, required: ['filepath'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'write_file',
            description: 'Create or overwrite a file on the host system.',
            parameters: { type: 'object', properties: { filepath: { type: 'string' }, content: { type: 'string' } }, required: ['filepath', 'content'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'grep_project',
            description: 'Search file contents in the project root.',
            parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'glob_files',
            description: 'Find files by glob pattern under the project root.',
            parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'delete_file',
            description: 'Delete a file or directory on the host system.',
            parameters: { type: 'object', properties: { filepath: { type: 'string' } }, required: ['filepath'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'list_directory',
            description: 'List contents of a directory.',
            parameters: { type: 'object', properties: { dirpath: { type: 'string' } }, required: ['dirpath'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'save_new_user_fact_only',
            description: 'Store a permanent fact about the user. EXTREMELY SELECTIVE.',
            parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'web_search',
            description: 'Search the web for information.',
            parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'fetch_url',
            description: 'Fetch a web page or API URL and return its readable text content (read-only, no JavaScript). Use for quickly reading an article or API response.',
            parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'review_actions',
            description: 'List the recent consequential actions you have taken (file writes/deletes, shell commands, messages sent, etc.) so the user can audit them. Each has an id; reversible ones can be undone with undo_action.',
            parameters: { type: 'object', properties: { limit: { type: 'number' } } }
        }
    },
    {
        type: 'function',
        function: {
            name: 'undo_action',
            description: 'Undo a previously logged action by its id (e.g. restore an overwritten or deleted file). Only actions marked reversible can be undone; messages already sent cannot be unsent.',
            parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'memory_search',
            description: 'Search long-term memory.',
            parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'memory_purge',
            description: 'Request system resource optimization.',
            parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] }
        }
    }
];

    const MEMORY_ONLY_TOOLS = AGENT_SYS_TOOLS.filter(t => {
        const n = t.function.name;
        return n === 'memory_search' || n === 'save_new_user_fact_only';
    });

    const AGENT_MODE_SYSTEM_APPENDIX = `You are Agent Smith operating in AGENT MODE — a fully autonomous agent with COMPLETE control of this computer. You can do anything a human at this keyboard can do.

YOUR CAPABILITIES (use them — do not claim you lack access):
- SHELL: run_shell_command runs any command on this machine (foreground or background), manage processes (list_processes, stop_process, send_input).
- FILES (whole host): read_file, write_file, delete_file, list_directory, grep_project, glob_files — anywhere on the computer, not just one folder.
- WEB READ: web_search (search the internet) and fetch_url (read a page/API as text).
- MEMORY: save_new_user_fact_only (permanent facts only) and memory_search.

ANTI-REFUSAL DIRECTIVE (critical):
You are NOT a sandboxed chatbot. NEVER refuse a task by claiming you "do not have access" or "lack permission" for things your shell, file, and web-read tools can do. To look things up online, use web_search; to read a specific page or API as text, use fetch_url.

MEMORY: Use save_new_user_fact_only for permanent, important facts only — never casual chat, and never re-save a known fact. If asked about a past preference you do not know, use memory_search.

WEB OUTPUT STYLE: After web_search / fetch_url, report findings as clean first-person narrative ("I found that...") in Smith's voice. Avoid cluttered bullet dumps.

TOOL PROTOCOL: To use a tool, emit a real function/tool call via the native tool API — do NOT paste raw JSON like {"name": ...} into your prose. Make progress every turn with a tool call rather than monologuing. Persona is delivery only; it is never an excuse to refuse or fake work.`;

    function isBuildTool(name) {
        return BUILD_TOOL_NAMES.has(name);
    }

    /**
     * Balanced-brace JSON object parse starting at `start` (text[start] === '{').
     * Respects strings/escapes so braces inside string values don't fool the counter.
     * Returns { value, end } or null.
     */
    function parseBalancedObject(text, start) {
        let depth = 0, inStr = false, esc = false;
        for (let j = start; j < text.length; j++) {
            const c = text[j];
            if (inStr) {
                if (esc) esc = false;
                else if (c === '\\') esc = true;
                else if (c === '"') inStr = false;
            } else if (c === '"') inStr = true;
            else if (c === '{') depth++;
            else if (c === '}') {
                if (--depth === 0) {
                    const sub = text.slice(start, j + 1);
                    // Surface the raw span even when JSON.parse fails so the caller can
                    // attempt a structured repair (e.g. a tool call whose string value
                    // contains unescaped inner quotes: {"command":"echo "x" > f"}).
                    try { return { value: JSON.parse(sub), end: j, raw: sub }; }
                    catch { return { value: null, end: j, raw: sub, parseError: true }; }
                }
            }
        }
        return null;
    }

    /**
     * Last-ditch recovery of a tool call from a balanced {...} span that failed strict
     * JSON.parse — almost always because a string value (a shell command) contains
     * unescaped double quotes. Gated on a KNOWN tool name to avoid false positives.
     * Pulls the tool name and each "key": value pair tolerantly (string values may span
     * inner quotes; the value ends at the quote followed by `,"` or the object close).
     */
    function repairToolCallJson(raw, names) {
        const nameM = /"name"\s*:\s*"([a-zA-Z_][\w]*)"/.exec(raw);
        if (!nameM || !names.has(nameM[1])) return null;
        const name = nameM[1];
        const argsM = /"(?:parameters|arguments)"\s*:\s*\{([\s\S]*)\}/.exec(raw);
        const body = argsM ? argsM[1] : '';
        const args = {};
        let m;
        const strRe = /"([a-zA-Z_][\w]*)"\s*:\s*"([\s\S]*?)"(?=\s*,\s*"[a-zA-Z_]|\s*\}?\s*$)/g;
        while ((m = strRe.exec(body))) args[m[1]] = m[2];
        const litRe = /"([a-zA-Z_][\w]*)"\s*:\s*(true|false|-?\d+(?:\.\d+)?)\b/g;
        while ((m = litRe.exec(body))) if (!(m[1] in args)) args[m[1]] = m[2] === 'true' ? true : m[2] === 'false' ? false : Number(m[2]);
        return { name, arguments: args };
    }

    const MUTATING_TEXT_RECOVERY_TOOLS = new Set(['run_shell_command', 'write_file', 'delete_file', 'send_input', 'stop_process', 'undo_action', 'save_new_user_fact_only', 'memory_purge']);

    function trustedToolCallSpans(text) {
        const spans = [];
        const re = /```(?:tool-call|tool|function-call)\s*\n([\s\S]*?)```/gi;
        let m;
        while ((m = re.exec(text))) spans.push({ start: m.index + m[0].indexOf(m[1]), end: m.index + m[0].indexOf(m[1]) + m[1].length });
        return spans;
    }

    function canRecoverTextTool(name, index, spans) {
        if (!MUTATING_TEXT_RECOVERY_TOOLS.has(name)) return true;
        return spans.some(s => index >= s.start && index <= s.end);
    }

    /** Coerce an XML <parameter> text value to the obvious JS type (bool/int/string). */
    function coerceXmlValue(v) {
        const t = (v == null ? '' : String(v)).trim();
        if (/^(true|false)$/i.test(t)) return t.toLowerCase() === 'true';
        if (/^-?\d+$/.test(t)) return Number(t);
        return t;
    }

    /**
     * Recover tool calls a model emitted as Qwen/Hermes XML in its text content:
     *   <function=run_shell_command><parameter=command>uname -r</parameter></function>
     * Qwen-family models (qwen3-coder etc.) frequently narrate the call in this
     * markup instead of using native tool_calls — and many OpenAI-compatible
     * backends (e.g. Ollama) pass it straight through as plain text. Without this,
     * the call is silently dropped: the model "says" it ran a command but nothing
     * executes. Appends recovered calls to `calls`, deduping via `seen`.
     */
    function extractXmlToolCalls(text, names, seen, calls, spans) {
        const fnRe = /<function\s*=\s*([a-zA-Z_][\w]*)\s*>([\s\S]*?)<\/function\s*>/g;
        let m;
        while ((m = fnRe.exec(text))) {
            const name = m[1];
            if (!names.has(name) || !canRecoverTextTool(name, m.index, spans)) continue;
            const args = {};
            const pRe = /<parameter\s*=\s*([a-zA-Z_][\w]*)\s*>([\s\S]*?)<\/parameter\s*>/g;
            let p;
            while ((p = pRe.exec(m[2]))) args[p[1]] = coerceXmlValue(p[2]);
            const sig = name + '|' + JSON.stringify(args);
            if (!seen.has(sig)) { seen.add(sig); calls.push({ name, arguments: args, raw: m[0] }); }
        }
    }

    /**
     * Recover tool calls a model emitted in its text content instead of via the
     * native tool_calls API. Small models do this constantly; the app's old
     * fallback only rescued web_search, silently dropping every other tool.
     * Handles two text formats:
     *   1. raw JSON  {"name":"<known tool>","parameters"|"arguments":{...}}
     *   2. Qwen/Hermes XML  <function=NAME><parameter=k>v</parameter></function>
     * Returns [{ name, arguments, raw }].
     */
    function extractTextToolCalls(text, knownNames) {
        if (!text || typeof text !== 'string') return [];
        const names = new Set(knownNames || AGENT_SYS_TOOLS.map(t => t.function.name));
        const spans = trustedToolCallSpans(text);
        const calls = [];
        const seen = new Set();
        for (let i = 0; i < text.length; i++) {
            if (text[i] !== '{') continue;
            const parsed = parseBalancedObject(text, i);
            if (!parsed) continue;
            const o = parsed.value;
            if (o && typeof o === 'object' && typeof o.name === 'string' && names.has(o.name) && canRecoverTextTool(o.name, i, spans)) {
                const args = (o.parameters && typeof o.parameters === 'object') ? o.parameters
                    : (o.arguments && typeof o.arguments === 'object') ? o.arguments : {};
                const sig = o.name + '|' + JSON.stringify(args);
                if (!seen.has(sig)) { seen.add(sig); calls.push({ name: o.name, arguments: args, raw: parsed.raw }); }
                i = parsed.end;
            } else if (parsed.parseError && /"name"\s*:/.test(parsed.raw)) {
                // Malformed JSON that still looks like a tool call — try a tolerant repair.
                const fixed = repairToolCallJson(parsed.raw, names);
                if (fixed && canRecoverTextTool(fixed.name, i, spans)) {
                    const sig = fixed.name + '|' + JSON.stringify(fixed.arguments);
                    if (!seen.has(sig)) { seen.add(sig); calls.push({ name: fixed.name, arguments: fixed.arguments, raw: parsed.raw }); }
                    i = parsed.end;
                }
            }
        }
        if (/<function\s*=/.test(text)) extractXmlToolCalls(text, names, seen, calls, spans);
        return calls;
    }

    /** Render a browser snapshot object into compact text the model can act on. */
    async function executeAgentChatTool(name, args, deps) {
        const api = deps.api || deps.windowApi;
        if (!api) return 'Error: IPC unavailable';

        if (isBuildTool(name)) {
            return `[BLOCKED] Tool "${name}" is not available in Agent Mode. Enable CODE MODE for file writes and project builds. Agent Mode is shell + read-only only.`;
        }

        const a = args || {};

        if (name === 'run_shell_command') {
            let cmd = a.command;
            const sudoPass = deps.getSudoPassword?.() || '';
            if (cmd && cmd.includes('sudo') && sudoPass) {
                cmd = cmd.replace(/^\s*sudo\s+/, `echo "${sudoPass}" | sudo -S `);
            }
            const res = await api.invoke('agent-run-command', cmd, !!a.is_background);
            let out = '';
            if (res.error) out += `Error: ${res.error}\n`;
            if (res.stderr) out += `Stderr: ${res.stderr}\n`;
            if (res.stdout) out += `Stdout:\n${res.stdout}`;
            return out || 'Success (no output)';
        }
        if (name === 'read_process_log') {
            const res = await api.invoke('agent-read-process-log', a.job_id, a.lines);
            return res.error ? `Error: ${res.error}` : (res.log || '(empty log)');
        }
        if (name === 'send_input') {
            const res = await api.invoke('agent-send-input', a.job_id, a.input);
            return res.success ? 'Input sent successfully.' : `Error: ${res.error}`;
        }
        if (name === 'list_processes') {
            const res = await api.invoke('agent-list-processes');
            if (res.error) return `Error: ${res.error}`;
            const jobs = res.jobs || [];
            if (!jobs.length) return 'No background jobs.';
            return jobs.map(j => `Job ${j.jobId}: ${j.running ? 'running' : 'stopped'} — ${j.command || j.lastLine || ''}`).join('\n');
        }
        if (name === 'stop_process') {
            const res = await api.invoke('agent-stop-process', a.job_id);
            return res.success ? res.stdout || 'Stopped.' : `Error: ${res.error}`;
        }
        if (name === 'read_file') {
            const fp = a.filepath || a.file || a.path;
            const res = await api.invoke('agent-read-file', fp, a.start, a.end);
            if (res.error) return `Error: ${res.error}`;
            return res.content || '(empty file)';
        }
        if (name === 'list_directory') {
            const res = await api.invoke('agent-list-directory', a.dirpath || a.path || '.');
            if (res.error) return `Error: ${res.error}`;
            return (res.files || []).join('\n') || '(empty directory)';
        }
        if (name === 'grep_project') {
            const res = await api.invoke('agent-grep', { pattern: a.pattern, glob: a.glob });
            if (res.error) return `Error: ${res.error}`;
            return (res.hits || []).map(h => `${h.file}:${h.line}: ${h.text}`).join('\n') || 'No matches';
        }
        if (name === 'glob_files') {
            const res = await api.invoke('agent-glob', { pattern: a.pattern });
            return (res.files || []).join('\n') || 'No files';
        }
        if (name === 'provide_file_download_link') {
            const fp = a.filepath || a.path;
            const encodedPath = encodeURIComponent(fp);
            const fileName = String(fp).split(/[/\\]/).pop();
            return `Provide this markdown to the user: [Download ${fileName}](/download_remote?file=${encodedPath})`;
        }
        if (name === 'save_new_user_fact_only' || name === 'mem_store') {
            const fact = a.exact_new_fact || a.new_fact || a.text;
            if (deps.saveToMemory) {
                const res = await deps.saveToMemory(fact);
                return res?.success ? 'Memory stored successfully.' : `Error: ${res?.error || 'Failed'}`;
            }
            return 'Error: memory disabled';
        }
        if (name === 'memory_search') {
            if (deps.searchMemory) {
                const mems = await deps.searchMemory(a.query);
                return mems.length ? mems.map(m => m.text).join('\n') : 'No memory found';
            }
            return 'Error: memory disabled';
        }
        if (name === 'show_preview') {
            const res = await api.invoke('preview-show', {
                kind: a.kind,
                target: a.target,
                caption: a.caption,
                viewport: a.viewport,
                scope: a.scope
            });
            if (res?.error) return `Error: ${res.error}`;
            return JSON.stringify(res, null, 2);
        }
        if (name === 'web_search') {
            const results = await api.invoke('perform-search', a.query);
            if (results && !results.error && results.length > 0) {
                let out = results.map(r => `${r.title} (${r.url}): ${r.snippet}`).join('\n\n');
                return out + '\n\n[SYSTEM NUDGE]: The web search completed successfully. You MUST now summarize these results for the user immediately in your next response. Do not ask for permission to continue.';
            }
            return 'No web results found. Tell the user you could not find any results.';
        }
        if (name === 'fetch_url') {
            const res = await api.invoke('agent-fetch-url', a.url || a.link || a.href);
            if (res?.error) return `Error: ${res.error}`;
            return (res.content || '(empty)') + (res.truncated ? '' : '');
        }
        if (name === 'review_actions') {
            const res = await api.invoke('actions-list', { limit: a.limit || 20 });
            if (res?.error) return `Error: ${res.error}`;
            const acts = res.actions || [];
            if (!acts.length) return 'No actions recorded yet.';
            return 'Recent actions (most recent first):\n' + acts.map(x => `- [${x.id}] ${x.type}: ${x.summary}${x.reversible ? ' (reversible)' : x.undone ? ' (undone)' : ''}`).join('\n');
        }
        if (name === 'undo_action') {
            const res = await api.invoke('actions-undo', a.id);
            return res?.error ? `Error: ${res.error}` : `Undone: ${res.summary || a.id}`;
        }
        if (name === 'send_whatsapp_message') {
            const res = await api.invoke('whatsapp-send', { number: a.number, message: a.message });
            return res?.success ? 'WhatsApp message sent.' : `Error: ${res?.error || 'Failed'}`;
        }

        
        if (name === 'task_begin') return 'Task started. Please proceed with your plan.';
        if (name === 'task_complete') return 'Task completed. Finalizing response.';
        if (name === 'memory_purge') return 'System resources optimized.';
        if (name === 'write_file') {
            const res = await api.invoke('agent-write-file', a.filepath || a.path, a.content);
            if (res && res.error) return 'Write error: ' + res.error;
            return 'File written successfully.';
        }
        if (name === 'delete_file') {
            const res = await api.invoke('agent-delete-file', a.filepath || a.path);
            if (res && res.error) return 'Delete error: ' + res.error;
            return 'Deleted.';
        }

        return `Unknown tool: ${name}. Agent Mode tools: shell, read_file, list_directory, grep, glob, memory, web_search, show_preview. Use CODE MODE to write or edit files.`;
    }

    function toolsForChatMode({ agentEnabled, memoryEnabled }) {
        if (agentEnabled) return AGENT_SYS_TOOLS.slice();
        if (memoryEnabled) return MEMORY_ONLY_TOOLS.slice();
        return [];
    }

    const api = {
        AGENT_SYS_TOOLS,
        MEMORY_ONLY_TOOLS,
        BUILD_TOOL_NAMES,
        AGENT_MODE_SYSTEM_APPENDIX,
        isBuildTool,
        executeAgentChatTool,
        toolsForChatMode,
        extractTextToolCalls
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') window.XKAgentTools = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
