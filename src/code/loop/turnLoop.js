/**
 * Inner turn loop — one LLM call, parse tools, execute until model stops.
 */
'use strict';

const { streamCompletion } = require('./streamCompletion.js');
const { extractFromMessage } = require('../tools/extractor.js');
const { executeTool } = require('../tools/executor.js');
const { TurnDedup } = require('../tools/dedup.js');
const { selectToolsForTurn } = require('../tools/router.js');
const { fitBudget, estimateMessages } = require('../context/budget.js');
const { compactForPhaseTransition } = require('../context/phaseCompact.js');
const gemmaHarness = require('../context/gemmaHarness.js');
const { checkCompletion, runValidation, formatGateMessage, formatBeforeDoneMessage, maxReflectionsForSession, runMilestoneVerify, goalImpliesBuildWork } = require('../governor/completionGate.js');
const { buildWriteNudge, buildMissingRefsNudge } = require('../context/artifactHints.js');
const { buildFinalSummary } = require('./finalSummary.js');
const { phaseHint, WRITE_TOOLS } = require('./phases.js');
const { createDefaultMiddleware, runMiddlewareChain, applyPhaseAdvance } = require('./middleware.js');
const { toContextBlock, stepProgress, advancePastExploreIfNeeded } = require('../plan/codePlan.js');
const { MARK_CODE_STEP_DONE } = require('../tools/planTools.js');
const { seedPendingMissingRefs, pickNextMissing } = require('./missingRefGuard.js');
const { tryHarnessScaffold } = require('./harnessScaffold.js');

const SYSTEM_PROMPT = `You are Agent Smith, a coding agent. Work on the user's task autonomously using tools.

Rules (follow strictly):
1. write_file takes a file's COMPLETE content (up to ~400 lines). Use it for new files and to rewrite a file you must restructure. To change existing code use patch (set replace_all when the text repeats). Use append_file ONLY to add new content at the end — NEVER to revise code already in the file (that creates duplicate definitions).
2. JavaScript template literals MUST use backticks: \`repeat(\${n}, 30px)\` — not repeat(\${n}, 30px).
3. CSS selectors must match JS class names (e.g. .pacman in CSS if classList.add('pacman') in JS).
4. For web apps (HTML/CSS/JS): create ALL linked files (index.html, style.css, script.js) — ONE file per turn when possible.
5. After writing .js files, fix any syntax warnings returned by the tool. Use read_file to verify content.
6. Prefer patch for small fixes; write_file for new files or full rewrites; append_file only to continue a cut-off file. read_file before editing existing files. If a patch reports "Multiple exact matches", either set replace_all:true or rewrite the whole file with write_file — do NOT append.
7. Call list_project at most once at the start — the bootstrap already includes the tree.
8. When index.html exists but script.js or style.css is missing, create those files next — never rewrite index.html again.
9. For games: use a fixed maze/layout array, not random walls that block the player spawn. Constants (GRID_SIZE/ROWS/COLS) MUST match the map's real dimensions.
10. When done, give a brief summary — but the run is only accepted after every file passes syntax, all references resolve, selectors match, constants match the map, and the page loads without errors. The harness verifies this; you cannot mark success by asserting it.
11. Long-lived progress belongs in .agentsmith/PLAN.md and IMPLEMENT.md — update milestones when verify gates pass.`;

function trackFileTouch(session, name, args, toolResult) {
    if (!toolResult || toolResult.error || toolResult.skipped) return;
    if (name === 'write_file' || name === 'append_file' || name === 'patch') {
        const rel = toolResult.relPath || args.path;
        if (rel && !session.filesTouched.includes(rel)) {
            session.filesTouched.push(rel);
        }
    }
}

async function evaluateCompletionBlock(ctx, session, planArtifacts, execDeps) {
    const gateOpts = {
        planArtifacts: planArtifacts || session.planArtifacts,
        grindMode: session.grindMode !== false,
        projectMeta: session.projectMeta,
        agentRanOkAfterEdit: session.agentRanOkAfterEdit
    };

    const beforePayload = {
        filesTouched: session.filesTouched,
        goal: session.goal,
        grindMode: gateOpts.grindMode
    };

    if (execDeps?.fireHook) {
        const pluginVeto = await execDeps.fireHook('beforeDone', beforePayload);
        if (pluginVeto?.blocked) {
            return {
                allow: false,
                messages: [pluginVeto.reason || 'Blocked by plugin beforeDone hook'],
                status: 'incomplete',
                pluginBlocked: true,
                ranChecks: 0,
                checked: 0
            };
        }
    }

    const middleware = ctx.middleware || createDefaultMiddleware(ctx);
    const mwVeto = await runMiddlewareChain(middleware, 'beforeDone', {
        ctx, session, payload: beforePayload
    });
    if (mwVeto?.veto) {
        const msgs = mwVeto.messages || (mwVeto.message ? [mwVeto.message] : ['beforeDone middleware veto']);
        return {
            allow: false,
            messages: msgs,
            status: 'incomplete',
            middlewareBlocked: true,
            ranChecks: 0,
            checked: 0
        };
    }

    return checkCompletion(
        session.projectRoot,
        session.filesTouched,
        session.goal,
        gateOpts
    );
}

function emitVerifyBlocked(emit, gate, session, { reflection, madeProgress }) {
    const grindBlocked = gate.grindBlocked ||
        (gate.messages || []).some(m => /^\[(?:LINT|TEST) FAILED\]/i.test(m));
    emit({
        type: 'verify_blocked',
        subType: grindBlocked ? 'grind_blocked' : 'gate_blocked',
        messages: gate.messages,
        reflection,
        madeProgress,
        filesTouched: session.filesTouched
    });
}

async function handleCompletionReflection(ctx, session, planArtifacts, execDeps, emit, trace) {
    const gate = await evaluateCompletionBlock(ctx, session, planArtifacts, execDeps);
    if (!gate.allow) {
        const fileCount = new Set(session.filesTouched).size;
        const issueCount = (gate.messages || []).length;
        const missingCount = (gate.missingRefs || []).length;
        const snap = session._reflectSnap;
        const madeProgress = !!snap && (
            fileCount > snap.files
            || issueCount < snap.issues
            || missingCount < (snap.missingRefs ?? missingCount)
        );
        session._reflectSnap = { files: fileCount, issues: issueCount, missingRefs: missingCount };
        if (madeProgress) session.completionReflections = 0;

        if (gate.missingRefs?.length) {
            session.pendingMissingRefs = [...gate.missingRefs];
        } else {
            delete session.pendingMissingRefs;
        }

        const reflectionLimit = maxReflectionsForSession(session);
        if (session.completionReflections < reflectionLimit) {
            session.completionReflections++;
            const blockMsg = gate.middlewareBlocked || gate.pluginBlocked
                ? formatBeforeDoneMessage(gate.messages)
                : formatGateMessage(gate, session.goal, session.projectRoot);
            session.messages.push({ role: 'user', content: blockMsg });
            const noFiles = !(session.filesTouched || []).length;
            const missingRefs = gate.missingRefs || [];
            // Ensure fix turns can write (verify phase previously blocked write_file).
            if (!gate.allow && (noFiles || missingRefs.length)) {
                session.phase = 'implement';
            }
            if (missingRefs.length) {
                session.messages.push({
                    role: 'system',
                    content: buildMissingRefsNudge(missingRefs, session.goal, session.projectRoot)
                });
            } else if (noFiles && goalImpliesBuildWork(session.goal)) {
                session.messages.push({
                    role: 'system',
                    content: buildWriteNudge(session.goal, session.projectRoot)
                });
            }
            emit({ type: 'run_continue', reason: 'gate_retry', reflection: session.completionReflections });
            if (trace) trace.verifyBlocked((gate.messages || []).slice(0, 4).join(' | '), session.completionReflections);
            emitVerifyBlocked(emit, gate, session, {
                reflection: session.completionReflections,
                madeProgress
            });
            return { continue: true, gate: null, exitReason: null };
        }
        const scaffolded = await tryHarnessScaffold(session, execDeps, emit, gate);
        if (scaffolded?.ok) {
            session.completionReflections = 0;
            session.phase = 'verify';
            emit({ type: 'run_continue', reason: 'harness_scaffold', path: scaffolded.path });
            return { continue: true, gate: null, exitReason: null };
        }
        return {
            continue: false,
            gate,
            exitReason: `no progress after ${reflectionLimit} reflections with unresolved issues`
        };
    }
    return { continue: false, gate, exitReason: null };
}

async function runTurnLoop(ctx) {
    const {
        session, apiBaseUrl, emit, signal, execDeps, planAnchor, planArtifacts,
        qualityMonitor, earlyStop, trace, userDataPath, onCheckpoint, userPrompt,
        pluginToolNames = [], pluginToolSchemas = []
    } = ctx;

    const stream = ctx.streamCompletion || streamCompletion;
    const dedup = new TurnDedup();
    const middleware = ctx.middleware || createDefaultMiddleware(ctx);
    let continueLoop = true;
    let exitReason = null;
    let finalGate = null;

    const seededMissing = seedPendingMissingRefs(session, session.goal);
    if (seededMissing.length) {
        session.phase = 'implement';
        session._injectMissingRefsNudge = true;
    }

    async function finalize(reason, gate) {
        let validation;
        if (gate && gate.messages !== undefined) {
            validation = {
                status: gate.status,
                messages: gate.messages || [],
                ranChecks: gate.ranChecks ?? gate.checked ?? 0,
                acceptance: gate.acceptance,
                smoke: gate.smoke,
                allow: gate.allow
            };
        } else {
            validation = await runValidation(
                session.projectRoot,
                session.filesTouched,
                session.goal,
                {
                    planArtifacts: planArtifacts || session.planArtifacts,
                    grindMode: session.grindMode !== false,
                    projectMeta: session.projectMeta,
                    agentRanOkAfterEdit: session.agentRanOkAfterEdit
                }
            );
        }
        let status = validation.status;
        if (reason && status === 'done' && validation.ranChecks === 0) status = 'unverified';
        session.status = status;
        session.validation = {
            status,
            messages: validation.messages,
            ranChecks: validation.ranChecks
        };
        session.unresolved = validation.messages || [];

        const summary = buildFinalSummary({
            status,
            goal: session.goal,
            filesTouched: session.filesTouched,
            validation: { messages: validation.messages, ranChecks: validation.ranChecks },
            acceptance: validation.acceptance,
            smoke: validation.smoke,
            exitReason: reason
        });

        session.finalSummary = summary;
        if (trace) {
            trace.verifyGate(status, (validation.messages || []).slice(0, 6).join(' | '));
            trace.finalize(status, summary.slice(0, 300));
        }
        emit({ type: 'final_summary', status, summary, validation: session.validation, acceptance: validation.acceptance, smoke: validation.smoke });
        emit({ type: 'assistant_done', content: summary });
    }

    // Record an output-truncation event, warn the model/user, and signal whether to bail.
    // Returns true when truncation has repeated too often (caller sets exitReason via this).
    async function recordTruncation(message) {
        session.truncationCount = (session.truncationCount || 0) + 1;
        const outputChars = String(message?.content || '').length;
        const chunkLimits = [30, 20, 12];
        const chunkLines = chunkLimits[Math.min(session.truncationCount - 1, chunkLimits.length - 1)];
        emit({
            type: 'output_truncated',
            turn: session.turn,
            count: session.truncationCount,
            outputChars,
            chunkLines
        });
        if (trace && trace.verifyBlocked) trace.verifyBlocked('output truncated (token limit)', session.truncationCount);
        if (session.truncationCount > 3) {
            const scaffolded = await tryHarnessScaffold(session, execDeps, emit);
            if (scaffolded?.ok) {
                session.truncationCount = 0;
                session.completionReflections = 0;
                session.phase = 'verify';
                return false;
            }
            exitReason = 'model replies were repeatedly cut off at the server\'s output-length limit, which is separate from the context window. The configured context may be large while the server still caps each reply. Increase the server\'s max response/output tokens, or keep file writes in small appendable chunks.';
            return true;
        }
        emit({ type: 'run_continue', reason: 'truncation_retry', attempt: session.truncationCount });
        session.messages.push({
            role: 'user',
            content: '[CONTINUE — output truncated] Your reply was cut off; the run continues. Any COMPLETE file in it was saved. ' +
                `Your server appears to enforce a small per-reply cap despite the larger context window. Write ONE tool call with at most ${chunkLines} lines. ` +
                'For a new file, write_file only the first complete chunk; on later turns use append_file for the next chunk. ' +
                'End each chunk at a complete statement or block. Do not regenerate or repeat content already on disk.' +
                (session.pendingMissingRefs?.length
                    ? ` NEXT REQUIRED: create "${pickNextMissing(session.pendingMissingRefs)}" in a chunk of at most ${chunkLines} lines, then continue it with append_file on later turns.`
                    : '')
        });
        return false;
    }

    while (continueLoop) {
        const turnCheck = earlyStop.onTurn();
        if (turnCheck.stop) {
            emit({ type: 'error', message: turnCheck.reason });
            exitReason = turnCheck.reason;
            break;
        }

        session.turn++;
        dedup.reset();

        const tools = selectToolsForTurn({
            userPrompt: userPrompt || session.goal,
            turnIndex: session.turn - 1,
            phase: session.phase,
            pluginToolNames,
            pluginToolSchemas
        });
        if (session.codePlan?.steps?.length) {
            tools.push(MARK_CODE_STEP_DONE);
        }

        let messages = [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'system', content: phaseHint(session.phase || 'explore') },
            { role: 'system', content: planAnchor.toBlock() },
            ...session.messages
        ];
        if (session.codePlan?.steps?.length) {
            messages.splice(3, 0, { role: 'system', content: toContextBlock(session.codePlan, session.goal) });
        }

        const qHint = qualityMonitor.hintBlock();
        if (qHint) messages.push({ role: 'system', content: qHint });

        // Reserve output room proportional to the window (clamped 4096–16384 tokens) so the
        // model can emit a whole source file without being truncated at the window edge.
        // The previous 6144 cap was too small for single-file builds (e.g. a full Pac-Man
        // page) — the reply got chopped mid-CSS and zero files landed.
        // Reply budget. A reasoning model that exhausted the budget on internal
        // reasoning (and produced no output) bumps session.outReserveOverride so the
        // retry gets the full ceiling for reasoning + content.
        const outReserve = session.outReserveOverride
            || Math.min(8192, Math.max(4096, Math.floor(session.numCtx * 0.25)));
        messages = fitBudget(messages, session.numCtx, outReserve);

        const usedTokens = estimateMessages(messages);
        emit({
            type: 'context_budget',
            used: usedTokens,
            total: session.numCtx,
            turn: session.turn,
            toolCountSoFar: session.toolCount,
            phase: session.phase
        });

        let bodyMessages = messages.slice();
        if (gemmaHarness.isGemmaModel(session.model)) {
            bodyMessages = gemmaHarness.adaptMessagesForGemma(bodyMessages, session.model, {
                toolNames: tools.map(t => t.function.name),
                serializeToolHistory: true
            });
        }

        emit({
            type: 'turn_start',
            turn: session.turn,
            toolCountSoFar: session.toolCount,
            phase: session.phase,
            planProgress: session.codePlan ? stepProgress(session.codePlan) : null
        });

        const inferStart = Date.now();
        let result;
        try {
            result = await stream({
                apiBaseUrl,
                model: session.model,
                messages: bodyMessages,
                tools,
                signal,
                // Explicit reply budget (matches the reserved output room) so a full source
                // file fits — avoids servers that cap -1 at a tiny default and truncate.
                maxTokens: outReserve,
                temperature: session.codeTemperature,
                onDelta: (d) => emit({ type: 'delta', text: d })
            });
            if (trace) trace.inferenceOk(Date.now() - inferStart);
        } catch (e) {
            if (/aborted/i.test(e.message)) throw e;
            if (trace) trace.inferenceError(Date.now() - inferStart, e.message);
            const gate = await evaluateCompletionBlock(ctx, session, planArtifacts, execDeps);
            if (gate.allow) {
                finalGate = gate;
                break;
            }
            const scaffolded = await tryHarnessScaffold(session, execDeps, emit, gate);
            if (scaffolded?.ok) {
                session.completionReflections = 0;
                session.phase = 'verify';
                continue;
            }
            emit({ type: 'error', message: e.message });
            exitReason = e.message;
            break;
        }

        const msg = result.message;
        const extractSchemas = goalImpliesBuildWork(session.goal)
            ? selectToolsForTurn({
                userPrompt: userPrompt || session.goal,
                turnIndex: session.turn - 1,
                phase: 'implement',
                pluginToolNames,
                pluginToolSchemas
            })
            : tools;
        extractFromMessage(msg, extractSchemas, {
            salvagePath: (result.finishReason === 'length' && session.pendingMissingRefs?.length)
                ? pickNextMissing(session.pendingMissingRefs)
                : null
        });

        // Reasoning-model guard: if the model spent the whole reply budget on internal
        // reasoning and emitted no content and no tool call (finish_reason === 'length'),
        // give the next turn the full budget and tell it to stop reasoning and act. This
        // keeps reasoning models (e.g. gemma-4) from silently looping on empty output —
        // which presents as a "frozen" run. Code Mode only.
        const emptyOutput = !(msg.content && msg.content.trim()) && !(msg.tool_calls && msg.tool_calls.length);
        if (result.sawReasoning && result.finishReason === 'length' && emptyOutput) {
            session.reasoningModel = true;
            session.outReserveOverride = 8192;
            session.reasoningRetries = (session.reasoningRetries || 0) + 1;
            if (session.reasoningRetries <= 2) {
                emit({
                    type: 'reasoning_truncated',
                    turn: session.turn,
                    message: 'Model used the entire reply budget reasoning with no output — retrying with a larger budget and a brevity nudge.'
                });
                session.messages.push({
                    role: 'system',
                    content: 'You spent the entire reply budget on internal reasoning and produced no output. Stop reasoning now: in your next reply, immediately emit the required tool call (e.g. write_file) or the file contents. Keep any reasoning to at most one short sentence.'
                });
                continue;
            }
            // Exhausted retries: fall through so normal completion/exit logic applies.
        }

        session.messages.push({
            role: 'assistant',
            content: msg.content || '',
            tool_calls: msg.tool_calls
        });

        if (session.workflow === 'executing' && (!msg.tool_calls || !msg.tool_calls.length)
            && /submit_code_plan/i.test(msg.content || '')) {
            session.messages.push({
                role: 'system',
                content: buildMissingRefsNudge(
                    session.pendingMissingRefs || [],
                    session.goal,
                    session.projectRoot
                ) || buildWriteNudge(session.goal, session.projectRoot)
            });
            session.phase = 'implement';
            continue;
        }

        // Truncation: the model hit its output limit (finish_reason="length"). COMPLETE
        // files in the reply were still recovered by the extractor and will be executed
        // below (salvage progress); only the cut-off tail is lost. We tell the model it was
        // truncated and retry. If nothing parsed, retry straight away.
        const truncated = result.finishReason === 'length';

        if (!msg.tool_calls || !msg.tool_calls.length) {
            if (truncated) {
                if (await recordTruncation(msg)) { finalGate = null; continueLoop = false; break; }
                continue;
            }
            const reflection = await handleCompletionReflection(
                ctx, session, planArtifacts, execDeps, emit, trace
            );
            if (reflection.continue) continue;
            if (reflection.exitReason) exitReason = reflection.exitReason;
            finalGate = reflection.gate;
            continueLoop = false;
            break;
        }

        let pending = msg.tool_calls.slice();
        while (pending.length) {
            const tc = pending.shift();
            const name = tc.function.name;
            const args = tc.function.arguments || {};
            const dup = dedup.isDuplicate(name, args);

            const callId = tc.id || `call_${session.turn}_${session.toolCount}`;
            const toolStarted = Date.now();

            emit({ type: 'tool_start', name, args, callId });

            let toolResult;
            if (dup) {
                toolResult = { skipped: true, reason: 'Duplicate call this turn' };
            } else {
                const veto = await runMiddlewareChain(middleware, 'beforeTool', {
                    ctx, session, payload: { name, args, dup }
                });
                if (veto?.veto) {
                    toolResult = veto.result;
                } else {
                    toolResult = await executeTool(name, args, { ...execDeps, sessionId: session.id, session, trace });
                }
            }

            const ok = !toolResult.error && !toolResult.skipped && !toolResult.phaseBlocked;
            // Track whether the agent has run a foreground command successfully (exit 0)
            // since its last edit. A passing run of the project's own code/test is real
            // evidence the current files at least execute — the completion gate credits
            // this so scriptless JS projects aren't perpetually "unverified". A new write
            // invalidates the signal (the run no longer reflects the latest code).
            if (ok && name === 'run_command' && !args.is_background) session.agentRanOkAfterEdit = true;
            if (WRITE_TOOLS.has(name) && ok) session.agentRanOkAfterEdit = false;
            if (ok && WRITE_TOOLS.has(name)) dedup.clearFailures();
            dedup.recordResult(name, args, ok);
            qualityMonitor.record(name, ok, toolResult.error || toolResult.reason || toolResult.message);
            const stopCheck = earlyStop.onToolResult(ok, dup);
            session.toolCount++;

            if (trace && !dup) trace.toolExecute(name, ok, JSON.stringify(args).slice(0, 120));

            await runMiddlewareChain(middleware, 'afterTool', {
                ctx, session, payload: { name, args, toolResult, ok }
            });

            const toolWasWrite = WRITE_TOOLS.has(name) && ok;
            const prevPhase = session.phase;
            if (applyPhaseAdvance(session, { lastTool: name, toolWasWrite })) {
                const compact = compactForPhaseTransition(session, {
                    fromPhase: prevPhase,
                    toPhase: session.phase,
                    planAnchor,
                    planArtifacts
                });
                emit({
                    type: 'context_compacted',
                    fromPhase: prevPhase,
                    toPhase: session.phase,
                    droppedCount: compact.droppedCount,
                    keptCount: compact.keptCount,
                    turn: session.turn
                });
                emit({ type: 'phase_change', phase: session.phase, turn: session.turn });
                if (execDeps?.fireHook) {
                    try {
                        await execDeps.fireHook('phaseChange', {
                            fromPhase: prevPhase,
                            toPhase: session.phase,
                            droppedCount: compact.droppedCount,
                            keptCount: compact.keptCount
                        });
                    } catch (e) { /* non-fatal */ }
                }
            }

            if (ok && toolWasWrite && planArtifacts?.enabled) {
                const mv = await runMilestoneVerify(session.projectRoot, planArtifacts, session.filesTouched);
                if (mv.passed && mv.milestoneId) {
                    await planArtifacts.markMilestoneDone(mv.milestoneId);
                    planAnchor.addNote(`Milestone ${mv.milestoneId} verified`);
                }
            }

            const resultStr = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult, null, 2);
            session.messages.push({
                role: 'tool',
                tool_call_id: tc.id,
                name,
                content: resultStr
            });

            emit({
                type: 'tool_result',
                name,
                ok,
                result: toolResult,
                callId,
                durationMs: Date.now() - toolStarted,
                toolCountSoFar: session.toolCount,
                turn: session.turn
            });

            if (ok && name === 'mark_code_step_done' && toolResult?.advanced) {
                emit({ type: 'plan_step_update', codePlan: session.codePlan, complete: toolResult.complete });
            }

            if (ok) {
                trackFileTouch(session, name, args, toolResult);
                planAnchor.recordDone(`${name} on ${args.path || args.pattern || args.command || ''}`);
                if (toolWasWrite && advancePastExploreIfNeeded(session.codePlan, session.goal)) {
                    emit({ type: 'plan_step_update', codePlan: session.codePlan, complete: false });
                }
            }

            if (onCheckpoint) onCheckpoint();

            if (stopCheck.stop) {
                emit({ type: 'error', message: stopCheck.reason });
                exitReason = stopCheck.reason;
                continueLoop = false;
                pending = [];
                break;
            }
        }

        if (execDeps?.fireHook) {
            try {
                await execDeps.fireHook('afterToolBatch', {
                    turn: session.turn,
                    toolCount: session.toolCount
                });
            } catch (e) { /* non-fatal */ }
        }

        if (session._injectMissingRefsNudge) {
            delete session._injectMissingRefsNudge;
            const nudge = buildMissingRefsNudge(
                session.pendingMissingRefs,
                session.goal,
                session.projectRoot
            );
            if (nudge) {
                session.messages.push({ role: 'system', content: nudge });
                session.phase = 'implement';
            }
        }

        await runMiddlewareChain(middleware, 'afterTurn', {
            ctx, session, payload: { turn: session.turn, reason: continueLoop ? null : 'model_stop' }
        });

        if (execDeps?.fireHook) {
            try {
                await execDeps.fireHook('afterTurn', {
                    turn: session.turn,
                    phase: session.phase,
                    toolCount: session.toolCount
                });
            } catch (e) { /* non-fatal */ }
        }

        // The reply was cut off, but its complete files were just saved above. Tell the
        // model to continue with the next file, then retry (bail if it keeps truncating).
        if (truncated) {
            if (await recordTruncation(msg)) { finalGate = null; continueLoop = false; break; }
            continue;
        }

        if (result.finishReason === 'stop' && (!msg.tool_calls || !msg.tool_calls.length)) {
            continueLoop = false;
        }
    }

    await finalize(exitReason, finalGate);
}

module.exports = { runTurnLoop, SYSTEM_PROMPT };
