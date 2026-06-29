/**
 * Code Mode tool executor — patch-first edits with changeLedger snapshots.
 */
'use strict';

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { syntaxCheckFile } = require('../../shared/verificationHarness.js');
const { detectContentIssues } = require('../governor/completionGate.js');
const { assessCommand, blockedResult } = require('../../shared/commandPolicy.js');
const { advanceStep } = require('../plan/codePlan.js');

// Upper bound on a single write so one tool call can hold a COMPLETE source file.
// This only rejects content that already arrived in full — real output truncation is
// handled separately (streamCompletion surfaces finish_reason="length" and the turn loop
// retries in small append chunks). So this cap should be generous enough that a normal
// multi-file app's modules (often 400–800 lines) are NOT rejected: a 449-line utils.js
// being bounced at 400 forced weak models into a fragile write-first-400-then-append
// dance that corrupted files. The 64KB byte cap below is the real size backstop.
const MAX_WRITE_LINES = 1000;
const MAX_WRITE_BYTES = 65536;
const MAX_WRITE_CHARS = 65536;
const MAX_READ_LINES = 400;

function checkWriteChunkSize(content) {
    const s = String(content || '');
    const lineCount = s.split('\n').length;
    if (lineCount > MAX_WRITE_LINES) {
        return {
            error: `Content too large (${lineCount} lines, max ${MAX_WRITE_LINES}). ` +
                `Split the file into smaller modules, or write the first ${MAX_WRITE_LINES} lines with write_file ` +
                `and add the rest with append_file (new content only — never re-send code already on disk).`
        };
    }
    if (s.length > MAX_WRITE_BYTES) {
        return {
            error: `Content too large (${Math.round(s.length / 1024)}KB, max ${Math.round(MAX_WRITE_BYTES / 1024)}KB). ` +
                `Split it: write_file the first part, then append_file the remainder (new content only).`
        };
    }
    return null;
}

// Per-session write history: detect a file rewritten with identical content (churn
// with no improvement) so the harness can warn instead of silently looping.
const writeHistory = new Map(); // key `${sessionId}::${rel}` -> { hash, count }

function hashContent(s) {
    return crypto.createHash('sha1').update(String(s)).digest('hex');
}

/**
 * Top-level (column-0) JS declarations in `src` — `function/const/let/var/class NAME`.
 * Used to stop append_file from re-declaring a symbol that already exists, which is the
 * exact bug that produced five `gameLoop` definitions in the failed Pac-Man run. We only
 * look at column 0 so legitimately continuing a cut-off file (whose tail is indented body
 * lines, not new declarations) is never flagged.
 */
function topLevelJsDeclNames(src) {
    const names = new Set();
    const re = /^(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
    let m;
    while ((m = re.exec(String(src || '')))) names.add(m[1]);
    return names;
}

/** Warn when content clearly does not match the file's extension (CSS in .html, etc.). */
function contentTypeWarnings(relPath, content) {
    const ext = path.extname(relPath).toLowerCase();
    const c = String(content || '');
    const out = [];
    const hasHtmlTag = /<(?:!doctype|html|head|body|div|span|script|link|p|h1|ul|table|canvas)\b/i.test(c);
    const looksCss = /[.#]?[\w-]+\s*\{[^{}]*:[^{}]*;?[^{}]*\}/.test(c);
    const looksJs = /\b(?:function|const|let|var|=>)\b|document\.|addEventListener/.test(c);

    if (ext === '.html') {
        if (!hasHtmlTag && looksCss) out.push('content looks like CSS but is being written to an .html file — did you mean styles.css?');
    } else if (ext === '.css') {
        if (hasHtmlTag) out.push('content contains HTML markup but is being written to a .css file');
        else if (looksJs && !looksCss) out.push('content looks like JavaScript but is being written to a .css file');
    } else if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
        if (/^\s*<(?:!doctype|html)\b/i.test(c)) out.push('content starts with HTML but is being written to a .js file');
    }
    return out;
}

async function attachFileQualityHints(relPath, content, projectRoot) {
    const hints = [];
    for (const msg of detectContentIssues(relPath, content)) {
        hints.push(msg);
    }
    for (const msg of contentTypeWarnings(relPath, content)) {
        hints.push(msg);
    }
    const syn = await syntaxCheckFile(projectRoot, relPath);
    if (!syn.skipped && !syn.ok) {
        hints.push(`syntax error: ${syn.message}`);
    }
    return hints.length ? { warnings: hints } : null;
}

async function executeTool(name, args, deps) {
    const {
        sessionId, projectContext, editEngine, changeLedger,
        grepProject, globFiles, relPathFromRoot, spawnShell, fireHook, session
    } = deps;

    const a = args || {};

    if (fireHook) {
        const hook = await fireHook('beforeToolCall', { tool: name, name, args: a });
        if (hook?.blocked) {
            return { error: hook.reason || 'Blocked by plugin hook', pluginBlocked: true };
        }
    }

    async function dispatch() {
        switch (name) {
        case 'mark_code_step_done': {
            if (!session?.codePlan) {
                return { error: 'No approved plan is active for this run.' };
            }
            const adv = advanceStep(session.codePlan);
            if (a.note) {
                /* note captured via planAnchor in turnLoop */
            }
            return { success: true, ...adv };
        }
        case 'show_preview': {
            if (typeof deps.showPreview !== 'function') {
                return { error: 'Preview is not available in this environment.' };
            }
            return deps.showPreview({
                kind: a.kind,
                target: a.target,
                caption: a.caption,
                viewport: a.viewport,
                scope: a.scope
            });
        }
        case 'browser_verify': {
            if (typeof deps.browserVerify !== 'function') {
                return { error: 'Browser verify is not available in this environment.' };
            }
            return deps.browserVerify({
                target: a.target || a.path || 'index.html',
                checks: a.checks
            });
        }
        case 'query_run_trace': {
            const trace = deps.trace || session?.trace;
            if (!trace || typeof trace.query !== 'function') {
                return { error: 'Run trace not available yet.', steps: [], summary: { total: 0 } };
            }
            return trace.query({
                failuresOnly: a.failuresOnly,
                tool: a.tool,
                lastN: a.lastN
            });
        }
        case 'read_file': {
            const resolved = projectContext.resolvePath(a.path);
            if (resolved.error) return { error: resolved.error };
            let content;
            try {
                content = await fs.readFile(resolved.path, 'utf-8');
            } catch (e) {
                if (e.code === 'ENOENT') {
                    return { error: `File not found: ${a.path}. Use glob or list_project to find the correct path, then read_file again.` };
                }
                return { error: `Could not read ${a.path}: ${e.message}` };
            }
            const lines = content.split('\n');
            const offset = Math.max(1, parseInt(a.offset, 10) || 1);
            const limit = Math.min(MAX_READ_LINES, parseInt(a.limit, 10) || MAX_READ_LINES);
            const slice = lines.slice(offset - 1, offset - 1 + limit);
            const rel = relPathFromRoot(resolved.path);
            return {
                path: rel,
                totalLines: lines.length,
                offset,
                content: slice.map((l, i) => `${offset + i}|${l}`).join('\n')
            };
        }
        case 'patch': {
            if (String(a.find ?? '') === String(a.replace ?? '')) {
                return {
                    error: 'No-op patch rejected: find and replace are identical. Inspect the file and make a real change.'
                };
            }
            const r = await editEngine.apply(sessionId, a.path, a.find, a.replace, { replaceAll: a.replace_all });
            if (r.error) return r;
            const rel = r.relPath || a.path;
            let quality = null;
            try {
                const resolved = projectContext.resolvePath(a.path);
                if (!resolved.error) {
                    const content = await fs.readFile(resolved.path, 'utf-8');
                    quality = await attachFileQualityHints(rel, content, projectContext.getRoot());
                }
            } catch (e) { /* non-fatal */ }
            return {
                success: true,
                path: a.path,
                relPath: rel,
                note: r.note,
                fileDiff: r.fileDiff,
                linesAdded: r.linesAdded,
                linesRemoved: r.linesRemoved,
                ...(quality || {})
            };
        }
        case 'write_file': {
            if (!a.path || !String(a.path).trim()) {
                return { error: 'write_file requires a "path" (e.g. {"path":"src/app.js","content":"..."}). You sent no path — retry with both path and the full file content.' };
            }
            if (typeof a.content !== 'string') {
                return { error: 'write_file requires string content.' };
            }
            const chunkErr = checkWriteChunkSize(a.content);
            if (chunkErr) return chunkErr;
            if (String(a.content || '').length > MAX_WRITE_CHARS) {
                return { error: `Content exceeds ${MAX_WRITE_CHARS} chars — use append_file or patch for large edits.` };
            }
            const resolved = projectContext.resolvePath(a.path);
            if (resolved.error) return { error: resolved.error };
            let before = '';
            let existed = false;
            try {
                before = await fs.readFile(resolved.path, 'utf-8');
                existed = true;
            } catch (e) { /* new file */ }
            if (existed) {
                await changeLedger.snapshotBefore(sessionId, resolved.path, 'write');
            } else {
                await changeLedger.recordCreate(sessionId, resolved.path);
            }
            await fs.mkdir(path.dirname(resolved.path), { recursive: true });
            await fs.writeFile(resolved.path, a.content, 'utf-8');
            projectContext.establishFromFilePath(resolved.path);
            const rel = relPathFromRoot(resolved.path);
            const diffMeta = changeLedger.buildFileDiffResult(before.replace(/\r\n/g, '\n'), String(a.content).replace(/\r\n/g, '\n'), rel);
            const quality = await attachFileQualityHints(rel, String(a.content), projectContext.getRoot());

            const histKey = `${sessionId}::${rel}`;
            const hash = hashContent(a.content);
            const prev = writeHistory.get(histKey);
            const repeated = prev && prev.hash === hash;
            writeHistory.set(histKey, { hash, count: (prev ? prev.count : 0) + 1 });
            const warnings = (quality && quality.warnings) ? quality.warnings.slice() : [];
            if (repeated) warnings.push(`file rewritten with identical content (no improvement) — change the content or move on instead of re-writing ${rel}`);

            return {
                success: true,
                path: a.path,
                relPath: rel,
                created: !existed,
                rewrittenIdentical: !!repeated,
                fileDiff: diffMeta.fileDiff,
                linesAdded: diffMeta.linesAdded,
                linesRemoved: diffMeta.linesRemoved,
                ...(warnings.length ? { warnings } : {})
            };
        }
        case 'append_file': {
            if (!a.path || !String(a.path).trim()) {
                return { error: 'append_file requires "path" and "content". Create the file first with write_file.' };
            }
            const chunkErr = checkWriteChunkSize(a.content);
            if (chunkErr) return chunkErr;
            const resolved = projectContext.resolvePath(a.path);
            if (resolved.error) return { error: resolved.error };
            let before = '';
            try {
                before = await fs.readFile(resolved.path, 'utf-8');
            } catch (e) {
                if (e.code === 'ENOENT') {
                    return {
                        error: `append_file: file not found: ${a.path}. Create it first with write_file.`
                    };
                }
                return { error: `Could not read ${a.path}: ${e.message}` };
            }
            // append_file ONLY concatenates at end-of-file. For an HTML document that is
            // already closed, that places the new markup OUTSIDE <html> (the classic
            // "<div> after </html>" corruption). Refuse and point at the right tools.
            const appendExt = path.extname(resolved.path).toLowerCase();
            if (appendExt === '.html' || appendExt === '.htm') {
                if (/<\/html\s*>/i.test(before)) {
                    return {
                        error: `append_file would add content AFTER </html> (outside the document). ` +
                            `To add an element, use patch to insert it before </body>; to rebuild the page, use write_file.`
                    };
                }
            }
            if (appendExt === '.js' || appendExt === '.mjs' || appendExt === '.cjs') {
                const existingDecls = topLevelJsDeclNames(before);
                const dup = [...topLevelJsDeclNames(a.content)].filter(n => existingDecls.has(n));
                if (dup.length) {
                    return {
                        error: `append_file would create a DUPLICATE definition of ${dup.map(n => `"${n}"`).join(', ')} — ` +
                            `${dup.length === 1 ? 'it is' : 'they are'} already defined in ${a.path}. ` +
                            `Appending only adds to the end, so this would leave two copies (the bug that breaks the build). ` +
                            `To change existing code use patch (set replace_all if the text repeats); to rebuild the file use write_file.`
                    };
                }
            }
            await changeLedger.snapshotBefore(sessionId, resolved.path, 'append');
            const appended = String(a.content || '');
            const next = before + appended;
            await fs.writeFile(resolved.path, next, 'utf-8');
            projectContext.establishFromFilePath(resolved.path);
            const rel = relPathFromRoot(resolved.path);
            const diffMeta = changeLedger.buildFileDiffResult(
                before.replace(/\r\n/g, '\n'),
                next.replace(/\r\n/g, '\n'),
                rel
            );
            const quality = await attachFileQualityHints(rel, next, projectContext.getRoot());
            return {
                success: true,
                path: a.path,
                relPath: rel,
                appended: true,
                bytesAdded: appended.length,
                fileDiff: diffMeta.fileDiff,
                linesAdded: diffMeta.linesAdded,
                linesRemoved: diffMeta.linesRemoved,
                ...(quality || {})
            };
        }
        case 'grep': {
            const root = projectContext.getRoot();
            const r = await grepProject(root, a.pattern, a.glob || '**/*');
            if (r.error) return r;
            const hits = (r.hits || []).slice(0, 50);
            return { hits: hits.map(h => ({ file: h.file, line: h.line, text: h.text })), truncated: (r.hits || []).length > 50 };
        }
        case 'glob': {
            const root = projectContext.getRoot();
            const r = await globFiles(root, a.pattern || '**/*');
            if (r.error) return r;
            return { files: (r.files || []).slice(0, 100) };
        }
        case 'run_command': {
            const cwd = projectContext.getRoot();
            const cmd = a.command;
            const verdict = assessCommand(cmd, { projectRoot: projectContext.projectRoot || cwd, cwd });
            if (!verdict.allowed) return blockedResult(cmd, verdict.reason);
            if (a.is_background) {
                return deps.runBackgroundCommand(cmd, cwd, sessionId);
            }
            return deps.runForegroundCommand(cmd, cwd);
        }
        case 'list_project': {
            const tree = await projectContext.listProjectTree();
            return { tree };
        }
        default: {
            // Plugin tools: anything not a core tool is delegated to the plugin manager
            // (capability-gated + sandboxed by the host). invokePluginTool returns a string,
            // or { __notFound:true } if no enabled plugin owns the name.
            if (typeof deps.invokePluginTool === 'function') {
                const out = await deps.invokePluginTool(name, a);
                if (!(out && out.__notFound)) {
                    const s = typeof out === 'string' ? out : JSON.stringify(out);
                    return /^Error[:\s]/i.test(s) ? { error: s } : { result: s, pluginTool: true };
                }
            }
            return { error: `Unknown tool: ${name}` };
        }
        }
    }

    const result = await dispatch();
    if (fireHook && result) {
        await fireHook('afterToolCall', { tool: name, name, args: a, result });
    }
    return result;
}

module.exports = {
    executeTool,
    MAX_WRITE_LINES,
    MAX_WRITE_BYTES,
    MAX_WRITE_CHARS,
    MAX_READ_LINES,
    checkWriteChunkSize,
    attachFileQualityHints
};
