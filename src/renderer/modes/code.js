/**
 * Code Mode renderer bridge — IPC + activity timeline + resume banner.
 */
(function (global) {
    'use strict';

    let eventUnsub = null;
    let activeSessionId = null;
    let depsRef = null;
    let timeline = null;
    let resumeBannerEl = null;
    // Composer-anchored verify popup — transient harness status (retries, verification).
    // Muted via localStorage; never appended to #messages (keeps transcript clean).
    const LS_VERIFY_MUTED = 'agentsmith_verify_popup_muted';
    let verifyPopupEl = null;
    let verifyMutedChipEl = null;
    let verifyPopupMuted = localStorage.getItem(LS_VERIFY_MUTED) === 'true';
    let lastVerifyText = '';

    function verifyHost() {
        return document.getElementById('verify-popup-host');
    }

    function ensureMutedChip(host) {
        if (verifyMutedChipEl) return verifyMutedChipEl;
        verifyMutedChipEl = document.createElement('button');
        verifyMutedChipEl.type = 'button';
        verifyMutedChipEl.className = 'verify-muted-chip';
        verifyMutedChipEl.textContent = 'Verify alerts muted — click to restore';
        verifyMutedChipEl.title = 'Show verification status popups again';
        verifyMutedChipEl.addEventListener('click', () => {
            verifyPopupMuted = false;
            localStorage.setItem(LS_VERIFY_MUTED, 'false');
            verifyMutedChipEl.hidden = true;
            if (lastVerifyText) setRunStatus(lastVerifyText);
        });
        host.appendChild(verifyMutedChipEl);
        return verifyMutedChipEl;
    }

    function ensureVerifyPopup() {
        const host = verifyHost();
        if (!host) return null;
        if (!verifyPopupEl) {
            verifyPopupEl = document.createElement('div');
            verifyPopupEl.className = 'verify-popup';
            verifyPopupEl.setAttribute('role', 'status');
            verifyPopupEl.innerHTML =
                '<span class="verify-popup-spinner" aria-hidden="true">↻</span>' +
                '<span class="verify-popup-text"></span>' +
                '<button type="button" class="verify-popup-mute" title="Mute verification alerts">Mute</button>' +
                '<button type="button" class="verify-popup-close" title="Dismiss" aria-label="Dismiss">×</button>';
            verifyPopupEl.querySelector('.verify-popup-mute')?.addEventListener('click', () => {
                verifyPopupMuted = true;
                localStorage.setItem(LS_VERIFY_MUTED, 'true');
                hideVerifyPopup();
                const chip = ensureMutedChip(host);
                chip.hidden = false;
            });
            verifyPopupEl.querySelector('.verify-popup-close')?.addEventListener('click', () => {
                hideVerifyPopup();
            });
            host.appendChild(verifyPopupEl);
        }
        if (verifyPopupMuted) {
            const chip = ensureMutedChip(host);
            chip.hidden = false;
        }
        return verifyPopupEl;
    }

    function hideVerifyPopup() {
        if (verifyPopupEl) {
            verifyPopupEl.hidden = true;
            verifyPopupEl.classList.remove('verify-popup--visible');
        }
    }

    function setRunStatus(text) {
        lastVerifyText = text || '';
        const host = verifyHost();
        if (!host) return;
        if (verifyPopupMuted) {
            const chip = ensureMutedChip(host);
            chip.hidden = false;
            return;
        }
        const el = ensureVerifyPopup();
        if (!el) return;
        el.querySelector('.verify-popup-text').textContent = text;
        el.hidden = false;
        el.classList.add('verify-popup--visible');
        if (verifyMutedChipEl) verifyMutedChipEl.hidden = true;
    }

    function clearRunStatus() {
        lastVerifyText = '';
        hideVerifyPopup();
    }

    async function showResumeBannerIfAny() {
        if (!depsRef?.getProjectRoot || !window.api) return;
        try {
            const root = await depsRef.getProjectRoot();
            const res = await window.api.invoke('code-list-sessions', { projectRoot: root });
            const sessions = res?.sessions || [];
            if (!sessions.length) {
                if (resumeBannerEl) resumeBannerEl.remove();
                resumeBannerEl = null;
                return;
            }
            const s = sessions[0];
            const messagesEl = document.getElementById('messages');
            if (!messagesEl) return;
            const awaiting = s.status === 'awaiting_approval';
            if (!resumeBannerEl) {
                resumeBannerEl = document.createElement('div');
                resumeBannerEl.className = 'code-resume-banner';
                messagesEl.prepend(resumeBannerEl);
            }
            const goal = (s.goal || 'task').slice(0, 80);
            if (awaiting) {
                resumeBannerEl.innerHTML =
                    `<strong>Plan awaiting approval</strong> — ${goal.replace(/</g, '&lt;')} ` +
                    `<button type="button" id="code-resume-btn">Review plan</button> ` +
                    `<button type="button" id="code-dismiss-resume">Dismiss</button>`;
            } else {
                resumeBannerEl.innerHTML =
                    `<strong>Resume Code run?</strong> Turn ${s.turn || 0}: ${goal.replace(/</g, '&lt;')} ` +
                    `<button type="button" id="code-resume-btn">Resume</button> ` +
                    `<button type="button" id="code-dismiss-resume">Dismiss</button>`;
            }
            document.getElementById('code-dismiss-resume')?.addEventListener('click', () => {
                resumeBannerEl?.remove();
                resumeBannerEl = null;
            });
            document.getElementById('code-resume-btn')?.addEventListener('click', async () => {
                const model = depsRef.getModel();
                const numCtx = depsRef.getNumCtx();
                const apiBaseUrl = depsRef.getApiBase();
                resumeBannerEl.innerHTML = '<span class="loading-pulse">Resuming…</span>';
                await depsRef.flushContextSync?.();
                await window.api.invoke('code-resume', {
                    sessionId: s.id,
                    model,
                    numCtx,
                    apiBaseUrl,
                    projectRoot: root
                });
                resumeBannerEl?.remove();
                resumeBannerEl = null;
            });
        } catch (e) { /* non-fatal */ }
    }

    function handleEvent(ev) {
        if (!ev || !ev.type || !depsRef) return;
        const { addMessage, onStatusUpdate, onReview, getModel, getNumCtx, getApiBase } = depsRef;
        const planPanel = window.XKCodePlanPanel;

        if (timeline) {
            timeline.handleCodeEvent(ev, { botDiv: depsRef.botDivRef, anchor: depsRef.botDivRef });
        }

        switch (ev.type) {
        case 'planning_start':
            window.XKSidebarLayout?.exitPreviewMode?.(); // clear any stale preview from a prior run
            planPanel?.renderPlanning({ goal: ev.goal });
            addMessage('system', '**Code Mode:** Planning — read-only exploration before approval.');
            break;
        case 'plan_awaiting_approval':
            activeSessionId = ev.sessionId || activeSessionId;
            planPanel?.renderApproval({
                goal: ev.goal,
                codePlan: ev.codePlan,
                sessionId: ev.sessionId,
                onApprove: async (sessionId, steps) => {
                    await depsRef.flushContextSync?.();
                    if (depsRef.codeRunState) depsRef.codeRunState.isBusy = true;
                    depsRef.setCodeLock?.(true);
                    const res = await window.api.invoke('code-plan-approve', {
                        sessionId,
                        steps,
                        model: getModel?.(),
                        numCtx: getNumCtx?.(),
                        apiBaseUrl: getApiBase?.()
                    });
                    if (res?.error) addMessage('system', `**Plan approval failed:** ${res.error}`);
                    if (depsRef.codeRunState) depsRef.codeRunState.isBusy = false;
                    depsRef.setCodeLock?.(false);
                },
                onReject: async (sessionId) => {
                    await window.api.invoke('code-plan-reject', { sessionId });
                    planPanel?.clear();
                    if (depsRef.codeRunState) depsRef.codeRunState.isBusy = false;
                    depsRef.setCodeLock?.(false);
                }
            });
            addMessage('system', '**Plan ready** — review steps in the sidebar, then **Approve & Run**.');
            if (depsRef.codeRunState) depsRef.codeRunState.isBusy = false;
            depsRef.setCodeLock?.(false);
            break;
        case 'plan_approved':
            clearRunStatus();
            planPanel?.renderExecuting({
                goal: ev.codePlan?.goal || ev.goal,
                codePlan: ev.codePlan,
                takeover: true
            });
            addMessage('system', '**Plan approved** — executing steps.');
            break;
        case 'plan_step_update':
            planPanel?.updateProgress(ev.codePlan);
            if (onStatusUpdate && ev.codePlan) {
                const total = ev.codePlan.steps?.length || 0;
                const done = ev.codePlan.steps?.filter(s => s.status === 'done').length || 0;
                onStatusUpdate({ planProgress: `${Math.min(done + 1, total)}/${total}` });
            }
            break;
        case 'plan_rejected':
            planPanel?.clear();
            addMessage('system', '**Plan rejected.**');
            break;
        case 'run_start':
            window.XKSidebarLayout?.exitPreviewMode?.(); // a new run supersedes any prior preview drawer
            clearRunStatus();
            activeSessionId = ev.sessionId;
            if (planPanel) {
                const st = planPanel.getState();
                if (ev.codePlan) {
                    planPanel.renderExecuting({
                        goal: ev.goal || ev.codePlan.goal,
                        codePlan: ev.codePlan,
                        takeover: true
                    });
                } else if (st.phase === 'idle') {
                    planPanel.renderRunActive({
                        goal: ev.goal,
                        sessionId: ev.sessionId,
                        takeover: true
                    });
                }
            }
            if (onStatusUpdate) onStatusUpdate({ turn: 0, sessionId: ev.sessionId });
            break;
        case 'turn_start':
            if (onStatusUpdate) {
                onStatusUpdate({
                    turn: ev.turn,
                    sessionId: activeSessionId,
                    toolCount: ev.toolCountSoFar,
                    phase: ev.phase,
                    planProgress: ev.planProgress
                        ? `${ev.planProgress.current}/${ev.planProgress.total}`
                        : undefined
                });
            }
            break;
        case 'context_budget':
            if (onStatusUpdate) {
                onStatusUpdate({
                    turn: ev.turn,
                    budgetPct: ev.total ? Math.round((ev.used / ev.total) * 100) : null,
                    toolCount: ev.toolCountSoFar
                });
            }
            break;
        case 'verify_blocked': {
            // Surface only the single most actionable next step on the live status
            // line. The full issue list lands in the final summary at run end.
            const msgs = ev.messages || [];
            const next = msgs.find(m => /create the file at|missing on disk/i.test(m)) || msgs[0] || '';
            const hint = next
                ? next.replace(/^\[[A-Z]+\]\s*/, '').replace(/\s*\(it is missing on disk\)/i, '').trim().slice(0, 140)
                : `resolving ${msgs.length} issue(s)`;
            setRunStatus(`Verifying — ${hint}`);
            break;
        }
        case 'run_continue': {
            // gate_retry fires just before verify_blocked, which carries the more
            // specific next-step text and wins (last update). Both share one line.
            if (ev.reason === 'harness_scaffold') {
                const prev = ev.previewOpened ? ' Preview opened.' : '';
                setRunStatus(`Continuing — harness wrote ${ev.path || 'missing file'}.${prev} Finishing verification…`);
            } else if (ev.reason === 'truncation_retry') {
                setRunStatus(`Reply was cut off — retrying with a smaller file (${ev.attempt || 1}/3)…`);
            } else if (ev.reason === 'gate_retry') {
                setRunStatus('Working — more changes needed before done…');
            }
            break;
        }
        case 'harness_scaffold':
            break;
        case 'output_truncated':
            break;
        case 'delta':
        case 'tool_start':
        case 'tool_result':
        case 'final_summary':
        case 'assistant_done':
            break;
        case 'done': {
            clearRunStatus();
            const label = ev.status && ev.status !== 'done'
                ? `Code run ${ev.status.toUpperCase()}`
                : 'Code run complete';
            addMessage('system', `**${label}** — ${ev.toolCount || 0} tool calls, ${ev.turn || 0} turns.`);
            window.XKCodePlanPanel?.clear();
            if (onReview) onReview(ev.sessionId);
            showResumeBannerIfAny();
            break;
        }
        case 'error':
            clearRunStatus();
            addMessage('system', `**Code Mode:** ${ev.message || 'error'}`);
            if (/stopped|aborted|rejected/i.test(ev.message || '')) {
                window.XKCodePlanPanel?.clear();
            }
            if (window.XKScrollFollow && window.XKScrollFollow.get()) {
                window.XKScrollFollow.get().endRun();
            }
            break;
        default:
            break;
        }

        if (window.XKHistoryPersistence?.shouldCheckpointCodeEvent(ev)) {
            depsRef.onTimelineChanged?.(ev);
        }
    }

    function mount(deps) {
        depsRef = deps;
        if (verifyPopupMuted) {
            const host = verifyHost();
            if (host) ensureMutedChip(host).hidden = false;
        }
        const messagesEl = document.getElementById('messages');
        if (window.XKActivityTimeline && messagesEl) {
            timeline = window.XKActivityTimeline.mount(messagesEl, {
                markedParse: deps.markedParse,
                updateEmptyState: deps.updateEmptyState,
                onStatusUpdate: deps.onStatusUpdate
            });
        }

        if (eventUnsub) eventUnsub();
        eventUnsub = window.api.on('code-event', handleEvent);

        showResumeBannerIfAny();

        return {
            async run(prompt, botDiv) {
                const { codeRunState } = deps;
                await deps.flushContextSync?.();
                codeRunState.isBusy = true;
                codeRunState.abortController = new AbortController();
                depsRef.botDivRef = botDiv;

                if (window.XKScrollFollow && window.XKScrollFollow.get()) {
                    window.XKScrollFollow.get().beginRun();
                }

                if (timeline) {
                    timeline.reset();
                    timeline.setAnchor(botDiv);
                }

                const model = deps.getModel();
                const numCtx = deps.getNumCtx();
                const maxTurns = deps.getMaxTurns?.() ?? 40;
                const codeTemperature = deps.getCodeTemperature?.() ?? 0.2;
                const projectRoot = await deps.getProjectRoot();
                const apiBaseUrl = deps.getApiBase();

                botDiv.innerHTML = `<span class="loading-pulse">Code Mode — starting…</span>`;

                const res = await window.api.invoke('code-run', {
                    prompt,
                    model,
                    numCtx,
                    maxTurns,
                    codeTemperature,
                    projectRoot,
                    apiBaseUrl,
                    requirePlanApproval: deps.getRequirePlanApproval?.() === true,
                    grindMode: deps.getGrindMode?.() !== false,
                    isolatedRun: deps.getIsolatedRun?.() === true,
                    parallelMilestones: deps.getParallelMilestones?.() === true,
                    milestoneWorktrees: deps.getMilestoneWorktrees?.() === true,
                    milestoneConcurrent: deps.getMilestoneConcurrent?.() === true
                });

                if (window.XKScrollFollow && window.XKScrollFollow.get()) {
                    window.XKScrollFollow.get().endRun();
                }

                codeRunState.isBusy = false;
                codeRunState.abortController = null;
                deps.setCodeLock?.(false);
                await deps.flushContextSync?.();

                if (res?.error && botDiv) {
                    botDiv.innerHTML = deps.markedParse(`**Code Mode error:** ${res.error}`);
                }
                if (res?.sessionId) {
                    activeSessionId = res.sessionId;
                    codeRunState.sessionId = res.sessionId;
                }
                return res;
            },

            async stop() {
                await window.api.invoke('code-stop');
                if (deps.codeRunState) deps.codeRunState.isBusy = false;
                await deps.flushContextSync?.();
            },

            getSessionId() { return activeSessionId; },
            refreshResumeBanner: showResumeBannerIfAny
        };
    }

    const api = { mount, handleEvent };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') window.XKCodeMode = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
