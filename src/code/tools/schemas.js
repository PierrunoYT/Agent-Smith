/**
 * Code Mode tool schemas — minimal v1 surface routed through main-process executor.
 */
const CODE_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read a file from the project (optionally a line range).',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Relative path from project root' },
                    offset: { type: 'number', description: '1-based start line (optional)' },
                    limit: { type: 'number', description: 'Max lines to read (optional)' }
                },
                required: ['path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'patch',
            description: 'Search/replace edit in a file — the right tool for CHANGING existing code. Provide exact find text and its replacement. Set replace_all when the find text occurs more than once and you want every occurrence replaced.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string' },
                    find: { type: 'string' },
                    replace: { type: 'string' },
                    replace_all: { type: 'boolean', description: 'Replace every occurrence of find (default false). Use this to fix "Multiple exact matches".' }
                },
                required: ['path', 'find', 'replace']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'write_file',
            description: 'Create or overwrite a file with its COMPLETE content (up to ~1000 lines / 64KB). Prefer this for new files and for rewriting a file you need to restructure — a full overwrite always leaves balanced braces and valid structure. To change a few lines of an existing file, use patch instead.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string' },
                    content: { type: 'string', description: 'The full file content' }
                },
                required: ['path', 'content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'append_file',
            description: 'Add NEW content to the END of an existing file. Use it ONLY to extend a file (e.g. continue a write that was cut off). Never use it to change code already in the file — that duplicates definitions. To modify existing code use patch; to rewrite use write_file.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string' },
                    content: { type: 'string', description: 'New content to add at end of file (not already present)' }
                },
                required: ['path', 'content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'grep',
            description: 'Search file contents in the project.',
            parameters: {
                type: 'object',
                properties: {
                    pattern: { type: 'string' },
                    glob: { type: 'string', description: 'Optional glob filter' }
                },
                required: ['pattern']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'glob',
            description: 'Find files matching a glob pattern.',
            parameters: {
                type: 'object',
                properties: {
                    pattern: { type: 'string' }
                },
                required: ['pattern']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'run_command',
            description: 'Run a shell command in the project root.',
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string' },
                    is_background: { type: 'boolean', description: 'Run in background' }
                },
                required: ['command']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'list_project',
            description: 'List project tree (skips node_modules, .git, dist).',
            parameters: { type: 'object', properties: {} }
        }
    },
    {
        type: 'function',
        function: {
            name: 'show_preview',
            description: 'Open the Preview panel for the user. kind=project_file (live iframe of workspace HTML), web_url (snapshot of a URL), screenshot (desktop/window capture; scope app|window|screen).',
            parameters: {
                type: 'object',
                properties: {
                    kind: { type: 'string', enum: ['project_file', 'web_url', 'screenshot'] },
                    target: { type: 'string', description: 'Relative project path or URL' },
                    caption: { type: 'string' },
                    viewport: {
                        type: 'object',
                        properties: {
                            width: { type: 'number' },
                            height: { type: 'number' }
                        }
                    },
                    scope: { type: 'string', enum: ['screen', 'window', 'app'], description: 'For screenshot kind only' }
                },
                required: ['kind']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'browser_verify',
            description: 'Load a project HTML file in a headless browser and verify it loads without console errors. Optional JS checks array.',
            parameters: {
                type: 'object',
                properties: {
                    target: { type: 'string', description: 'Relative path to HTML file (default index.html)' },
                    checks: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Optional JS expressions that must evaluate truthy (e.g. document.querySelector("#app"))'
                    }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'query_run_trace',
            description: 'Query the current Code run trace for failures, tool errors, and verify blocks. Use during verify phase to diagnose issues.',
            parameters: {
                type: 'object',
                properties: {
                    failuresOnly: { type: 'boolean', description: 'Return only error/failure steps (default true)' },
                    tool: { type: 'string', description: 'Filter by tool name' },
                    lastN: { type: 'number', description: 'Max steps to return (default 20, max 50)' }
                }
            }
        }
    }
];

const TOOL_CATEGORIES = {
    read: ['read_file', 'grep', 'glob', 'list_project', 'show_preview'],
    write: ['patch', 'write_file', 'append_file'],
    shell: ['run_command']
};

function toolNames() {
    return CODE_TOOLS.map(t => t.function.name);
}

function schemasForNames(names) {
    const set = new Set(names);
    return CODE_TOOLS.filter(t => set.has(t.function.name));
}

module.exports = { CODE_TOOLS, TOOL_CATEGORIES, toolNames, schemasForNames };
