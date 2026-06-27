/**
 * IPC domain: Code Mode — run/stop/status + event streaming + resume.
 */
'use strict';

const { runCodeTask } = require('../../code/loop/runCodeTask.js');
const { executeTool } = require('../../code/tools/executor.js');
const { CodeSession } = require('../../code/session/state.js');
const { createPlan, markApproved } = require('../../code/plan/codePlan.js');

module.exports = function registerCodeIpc(ipcMain, deps) {
    const {
        spawn, exec, projectContext, editEngine, changeLedger,
        grepProject, globFiles, relPathFromRoot, userDataPath,
        getLmsUrl, getMainWindow, pushEvent, pluginManager, memoryManager,
        previewRunner
    } = deps;

    // Cross-session vector memory adapter for Code Mode (best-effort; degrades silently
    // when embeddings/Ollama are unavailable).
    const memory = memoryManager ? {
        recall: async (q) => {
            try {
                const r = await memoryManager.queryVectors(q, 3);
                return (r && r.success && Array.isArray(r.data)) ? r.data.map(d => d.text) : [];
            } catch (e) { return []; }
        },
        remember: async (text, meta) => {
            try { await memoryManager.storeVector(text, meta || {}); } catch (e) { /* ignore */ }
        }
    } : null;

    let activeRun = null;
    const bgProcesses = new Map();
    let nextJobId = 1;

    function spawnShell(command, cwd) {
        const cfg = projectContext.getShellConfig();
        if (projectContext.isWindows()) {
            return spawn(cfg.shell, [cfg.flag, cfg.commandFlag, command], { cwd, shell: false });
        }
        return spawn(cfg.shell, [cfg.flag, command], { cwd });
    }

    function buildExecDeps(sessionId) {
        const fireHook = async (event, payload) => {
            if (!pluginManager?.fireHook) return null;
            try {
                return await pluginManager.fireHook(event, payload);
            } catch (e) {
                return { error: e.message };
            }
        };

        const invokePluginTool = async (name, args) => {
            if (!pluginManager?.isPluginTool || !pluginManager.isPluginTool(name)) {
                return { __notFound: true };
            }
            // Bound the call so a misbehaving plugin tool can't hang the run forever.
            const TIMEOUT_MS = 120000;
            let timer;
            const timeout = new Promise((resolve) => {
                timer = setTimeout(
                    () => resolve({ error: `Plugin tool "${name}" timed out after ${TIMEOUT_MS}ms` }),
                    TIMEOUT_MS
                );
                if (timer && typeof timer.unref === 'function') timer.unref();
            });
            try {
                return await Promise.race([pluginManager.invokeTool(name, args), timeout]);
            } finally {
                clearTimeout(timer);
            }
        };

        return {
            sessionId,
            projectContext,
            editEngine,
            changeLedger,
            grepProject,
            globFiles,
            relPathFromRoot,
            fireHook,
            invokePluginTool,
            showPreview: previewRunner
                ? (args) => previewRunner.show(args)
                : null,
            browserVerify: deps.browserVerify
                ? (args) => deps.browserVerify.run(args)
                : null,
            runForegroundCommand: (command, cwd) => new Promise((resolve) => {
                const FG_TIMEOUT_MS = 300000;
                const cfg = projectContext.getShellConfig();
                if (projectContext.isWindows()) {
                    exec(command, { cwd, timeout: FG_TIMEOUT_MS, shell: cfg.shell }, (error, stdout, stderr) => {
                        resolve({ error: error ? error.message : null, stdout: stdout || '', stderr: stderr || '' });
                    });
                } else {
                    exec(command, { cwd, timeout: FG_TIMEOUT_MS }, (error, stdout, stderr) => {
                        resolve({ error: error ? error.message : null, stdout: stdout || '', stderr: stderr || '' });
                    });
                }
            }),
            runBackgroundCommand: (command, cwd) => {
                const jobId = nextJobId++;
                const child = spawnShell(command, cwd);
                const procInfo = { log: [], running: true };
                bgProcesses.set(jobId, procInfo);
                const append = (data) => {
                    procInfo.log.push(...data.toString().split('\n').filter(Boolean));
                    if (procInfo.log.length > 500) procInfo.log = procInfo.log.slice(-500);
                };
                child.stdout?.on('data', append);
                child.stderr?.on('data', append);
                child.on('close', (code) => {
                    procInfo.log.push(`[exit ${code}]`);
                    procInfo.running = false;
                });
                return { stdout: `Background job ${jobId} started`, jobId };
            }
        };
    }

    function emit(event) {
        if (pushEvent) {
            pushEvent('code-event', event);
        } else {
            const win = getMainWindow?.();
            if (win && !win.isDestroyed()) {
                win.webContents.send('code-event', event);
            }
        }
    }

    function getPluginToolSchemas() {
        if (!pluginManager?.getEnabledToolSchemas) return [];
        try {
            return pluginManager.getEnabledToolSchemas();
        } catch (e) {
            return [];
        }
    }

    function isRunBlocking() {
        return activeRun && activeRun.status === 'running';
    }

    async function startCodeTask(opts, resumeSession) {
        const controller = new AbortController();
        activeRun = { status: 'running', controller, sessionId: resumeSession?.id || null };
        const pluginToolSchemas = getPluginToolSchemas();

        const base = {
            projectRoot: opts.projectRoot || resumeSession?.projectRoot || projectContext.getRoot(),
            model: opts.model || resumeSession?.model,
            numCtx: opts.numCtx || resumeSession?.numCtx || 8192,
            apiBaseUrl: opts.apiBaseUrl || getLmsUrl?.() || 'http://127.0.0.1:1234',
            userDataPath,
            projectContext,
            buildExecDeps,
            emit: (ev) => {
                if (ev.sessionId) activeRun.sessionId = ev.sessionId;
                emit(ev);
            },
            signal: controller.signal,
            maxTurns: opts.maxTurns || 40,
            codeTemperature: opts.codeTemperature ?? 0.2,
            forcePlan: opts.forcePlan,
            requirePlanApproval: opts.requirePlanApproval,
            continueAfterApproval: opts.continueAfterApproval,
            grindMode: opts.grindMode !== false,
            pluginToolSchemas,
            memory,
            pluginManager
        };

        if (resumeSession) {
            base.resumeSession = resumeSession;
            base.sessionId = resumeSession.id;
        } else {
            base.prompt = opts.prompt;
        }

        return runCodeTask(base).then((session) => {
            activeRun = { status: session.status, sessionId: session.id, session };
            return {
                success: true,
                sessionId: session.id,
                status: session.status,
                awaitingApproval: session.status === 'awaiting_approval'
            };
        }).catch((e) => {
            activeRun = { status: 'error', error: e.message };
            return { error: e.message };
        });
    }

    ipcMain.handle('code-run', async (_event, opts) => {
        if (isRunBlocking()) {
            return { error: 'A code run is already active. Stop it first.' };
        }

        const prompt = opts?.prompt;
        const projectRoot = opts?.projectRoot || projectContext.getRoot();
        const model = opts?.model;
        const numCtx = opts?.numCtx || 8192;
        const apiBaseUrl = opts?.apiBaseUrl || getLmsUrl?.() || 'http://127.0.0.1:1234';

        if (!prompt) return { error: 'prompt is required' };
        if (!model) return { error: 'model is required' };

        return startCodeTask({
            prompt,
            projectRoot,
            model,
            numCtx,
            apiBaseUrl,
            maxTurns: opts?.maxTurns,
            codeTemperature: opts?.codeTemperature,
            forcePlan: opts?.forcePlan,
            requirePlanApproval: !!opts?.requirePlanApproval,
            grindMode: opts?.grindMode !== false,
            isolatedRun: !!opts?.isolatedRun,
            parallelMilestones: !!opts?.parallelMilestones,
            milestoneWorktrees: !!opts?.milestoneWorktrees,
            milestoneConcurrent: !!opts?.milestoneConcurrent
        });
    });

    ipcMain.handle('code-readiness', async (_event, opts) => {
        const root = opts?.projectRoot || projectContext.getRoot();
        if (!root) return { error: 'No project root set' };
        const { scoreReadiness } = require('../../code/governor/readiness.js');
        return scoreReadiness(root);
    });

    ipcMain.handle('code-resume', async (_event, opts) => {
        if (isRunBlocking()) {
            return { error: 'A code run is already active. Stop it first.' };
        }
        const sessionId = opts?.sessionId;
        if (!sessionId) return { error: 'sessionId is required' };

        const session = await CodeSession.load(userDataPath, sessionId);
        if (!session) return { error: 'Session not found' };

        const model = opts?.model || session.model;
        const numCtx = opts?.numCtx || session.numCtx;
        const apiBaseUrl = opts?.apiBaseUrl || getLmsUrl?.() || 'http://127.0.0.1:1234';

        return startCodeTask({
            model,
            numCtx,
            apiBaseUrl,
            requirePlanApproval: false,
            continueAfterApproval: session.status === 'awaiting_approval' && !!opts?.continueAfterApproval
        }, session);
    });

    ipcMain.handle('code-plan-approve', async (_event, opts) => {
        if (isRunBlocking()) {
            return { error: 'A code run is already active. Stop it first.' };
        }
        const sessionId = opts?.sessionId;
        if (!sessionId) return { error: 'sessionId is required' };

        const session = await CodeSession.load(userDataPath, sessionId);
        if (!session) return { error: 'Session not found' };
        if (session.status !== 'awaiting_approval') {
            return { error: 'Session is not awaiting plan approval' };
        }

        if (Array.isArray(opts?.steps) && opts.steps.length) {
            session.codePlan = createPlan(session.goal, opts.steps);
        }
        markApproved(session.codePlan);
        if (pluginManager?.fireHook) {
            await pluginManager.fireHook('onPlanApproved', {
                sessionId: session.id,
                goal: session.goal,
                codePlan: session.codePlan
            });
        }
        await CodeSession.save(userDataPath, session);

        return startCodeTask({
            model: opts?.model || session.model,
            numCtx: opts?.numCtx || session.numCtx,
            apiBaseUrl: opts?.apiBaseUrl || getLmsUrl?.() || 'http://127.0.0.1:1234',
            requirePlanApproval: false,
            continueAfterApproval: true,
            grindMode: opts?.grindMode !== false
        }, session);
    });

    ipcMain.handle('code-plan-reject', async (_event, opts) => {
        const sessionId = opts?.sessionId;
        if (!sessionId) return { error: 'sessionId is required' };

        const session = await CodeSession.load(userDataPath, sessionId);
        if (!session) return { error: 'Session not found' };

        session.status = 'aborted';
        session.finishedAt = Date.now();
        session.error = 'Plan rejected by user';
        await CodeSession.save(userDataPath, session);

        if (activeRun?.sessionId === sessionId) {
            activeRun = { status: 'aborted', sessionId };
        }

        emit({ type: 'plan_rejected', sessionId, goal: session.goal });
        return { success: true, sessionId };
    });

    ipcMain.handle('code-list-sessions', async (_event, opts) => {
        const projectRoot = opts?.projectRoot || projectContext.getRoot();
        const list = await CodeSession.listIncomplete(userDataPath, projectRoot);
        return { sessions: list };
    });

    ipcMain.handle('code-stop', async () => {
        if (!activeRun || activeRun.status !== 'running') {
            return { success: false, message: 'No active run' };
        }
        activeRun.controller?.abort();
        activeRun.status = 'aborted';
        emit({ type: 'error', message: 'Run stopped by user' });
        return { success: true };
    });

    ipcMain.handle('code-get-status', async () => {
        if (!activeRun) return { status: 'idle' };
        return {
            status: activeRun.status,
            sessionId: activeRun.sessionId || null
        };
    });

    ipcMain.handle('code-ledger-diff', async (_event, sessionId) => {
        const id = sessionId || activeRun?.sessionId;
        if (!id) return { error: 'No session id' };
        return changeLedger.diff(id);
    });
};
