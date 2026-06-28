/**
 * Auto-advance approved plan steps when deliverables land on disk (models rarely
 * call mark_code_step_done). Heuristics require DOM contract clean for JS-heavy steps.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const wv = require('../governor/webValidators.js');
const { advanceStep, currentStep } = require('./codePlan.js');

function fileExists(projectRoot, name) {
    if (!projectRoot || !name) return false;
    const direct = path.join(projectRoot, name);
    if (fs.existsSync(direct)) return true;
    try {
        for (const e of fs.readdirSync(projectRoot, { withFileTypes: true })) {
            if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules'
                && fs.existsSync(path.join(projectRoot, e.name, name))) {
                return true;
            }
        }
    } catch (e) { /* ignore */ }
    return false;
}

function readHtml(projectRoot) {
    for (const rel of ['index.html']) {
        try {
            const p = path.join(projectRoot, rel);
            if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
        } catch (e) { /* ignore */ }
    }
    try {
        for (const e of fs.readdirSync(projectRoot, { withFileTypes: true })) {
            if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
                const p = path.join(projectRoot, e.name, 'index.html');
                if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
            }
        }
    } catch (e) { /* ignore */ }
    return '';
}

function readScript(projectRoot) {
    for (const rel of ['script.js', 'app.js', 'main.js']) {
        try {
            const p = path.join(projectRoot, rel);
            if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
        } catch (e) { /* ignore */ }
    }
    return '';
}

function goalRequiresReadme(goal) {
    return /\bREADME\.md\b/i.test(String(goal || ''));
}

/** True when index.html + script.js exist and every getElementById target is in HTML. */
function domContractClean(projectRoot) {
    const html = readHtml(projectRoot);
    const js = readScript(projectRoot);
    if (!html.trim() || !js.trim()) return true;
    return wv.validateDomIdConsistency({ html, js })
        .every(i => i.level !== 'error');
}

function domMismatchMessages(projectRoot) {
    const html = readHtml(projectRoot);
    const js = readScript(projectRoot);
    if (!html.trim() || !js.trim()) return [];
    return wv.validateDomIdConsistency({ html, js })
        .filter(i => i.level === 'error')
        .map(i => `[DOM] ${i.message}`);
}

function touchedMatches(filesTouched, extRe) {
    return (filesTouched || []).some(f => extRe.test(String(f).replace(/\\/g, '/')));
}

function stepNeedsDomClean(title) {
    const t = String(title || '').toLowerCase();
    return /\blocalstorage\b|\bpersist|\bfilter|\bform\b|\btransaction|\binteractions?\b|\bcrud\b|add\/edit\/delete|edit.*delete|\bimport\b|\bexport\b|\bcategor|\btheme\b/.test(t);
}

function planAllStepsDone(plan) {
    return !!plan?.steps?.length && plan.steps.every(s => s.status === 'done');
}

/** Lightweight blocker scan for plan UI + nudges (no smoke/functional). */
function collectPlanBlockers(projectRoot, goal, filesTouched) {
    const messages = [];
    if (goalRequiresReadme(goal) && !fileExists(projectRoot, 'README.md')) {
        messages.push('[ARTIFACT] README.md is required by the prompt but missing');
    }
    messages.push(...domMismatchMessages(projectRoot));
    return { count: messages.length, messages };
}

function planProgressPayload(plan, projectRoot, goal, filesTouched) {
    const allDone = planAllStepsDone(plan);
    const blockers = collectPlanBlockers(projectRoot, goal, filesTouched);
    return {
        codePlan: plan,
        complete: allDone && blockers.count === 0,
        gateBlockerCount: blockers.count,
        gateBlockers: blockers.messages.slice(0, 5)
    };
}

/**
 * Heuristic: is this plan step's deliverable satisfied on disk?
 */
function isStepSatisfied(title, projectRoot, filesTouched, goal) {
    const t = String(title || '').toLowerCase();
    const touched = filesTouched || [];

    if (/\bindex\.html\b|\bhtml structure\b|\bhtml file\b|\bbasic structure\b|\bui elements\b/.test(t)) {
        if (fileExists(projectRoot, 'index.html') || touchedMatches(touched, /\.html?$/i)) return true;
    }
    if (/\bstyle\.css\b|\bcss file\b|\bstyling\b|\bresponsive design\b|\blayout and theme\b/.test(t)) {
        if (fileExists(projectRoot, 'style.css') || touchedMatches(touched, /\.css$/i)) return true;
    }
    if (/\bscript\.js\b|\bjavascript\b|\bapp logic\b|\bcore logic\b|\bjs file\b/.test(t)) {
        if (fileExists(projectRoot, 'script.js') || touchedMatches(touched, /\.(js|mjs|cjs)$/i)) return true;
    }
    if (/\breadme\.md\b|\breadme\b|\bdocumentation\b/.test(t)) {
        if (fileExists(projectRoot, 'README.md')) return true;
    }

    if (/create required files|html.*css.*js/i.test(t)) {
        const hasHtml = fileExists(projectRoot, 'index.html') || touchedMatches(touched, /\.html?$/i);
        const hasCss = fileExists(projectRoot, 'style.css') || touchedMatches(touched, /\.css$/i);
        const hasJs = fileExists(projectRoot, 'script.js') || touchedMatches(touched, /\.(js|mjs|cjs)$/i);
        return hasHtml && hasCss && hasJs;
    }

    if (/html structure and responsive styling/i.test(t)) {
        return (fileExists(projectRoot, 'index.html') || touchedMatches(touched, /\.html?$/i))
            && (fileExists(projectRoot, 'style.css') || touchedMatches(touched, /\.css$/i));
    }

    if (/\bverif|\bpreview\b|\btest\b|\bfinal\b/i.test(t)) {
        if (goalRequiresReadme(goal) && !fileExists(projectRoot, 'README.md')) return false;
        if (!fileExists(projectRoot, 'index.html') || !fileExists(projectRoot, 'script.js')) return false;
        if (!domContractClean(projectRoot)) return false;
        return true;
    }

    if (stepNeedsDomClean(t) && !domContractClean(projectRoot)) {
        return false;
    }

    const js = readScript(projectRoot);
    if (js) {
        if (/\blocalstorage\b|\bpersist/i.test(t) && /\blocalStorage\s*\.\s*(setItem|getItem)/i.test(js)) {
            return true;
        }
        if (/\bfilter/i.test(t) && /\bfilter/i.test(js)) return true;
        if (/\bform\b|\btransaction/i.test(t)
            && /(addEventListener\s*\(\s*['"]submit|transaction|getElementById)/i.test(js)) {
            return true;
        }
        if (/\bimport\b|\bexport\b/i.test(t) && /\b(import|export)\b/.test(js)) return true;
        if (/\bcategor/i.test(t) && /\bcategor/i.test(js)) return true;
        if (/\btheme\b|\bdark mode\b|\blight mode\b/i.test(t) && /\btheme\b/i.test(js)) return true;
        if (/\binteractions?\b|\bcrud\b|add\/edit\/delete|edit.*delete/i.test(t)
            && /(addEventListener|delete|edit)/i.test(js)) return true;
    }

    return false;
}

/**
 * Advance every consecutive satisfied step (current step first).
 * @returns {{ advanced: number, complete: boolean }}
 */
function autoAdvancePlanSteps(plan, projectRoot, filesTouched, goal) {
    if (!plan?.steps?.length) return { advanced: 0, complete: false };
    let advanced = 0;
    let complete = false;
    const maxBurst = 12;
    while (advanced < maxBurst) {
        const cur = currentStep(plan);
        if (!cur || cur.status === 'done') break;
        if (!isStepSatisfied(cur.title, projectRoot, filesTouched, goal)) break;
        const r = advanceStep(plan);
        if (!r.advanced) break;
        advanced++;
        complete = !!r.complete;
    }
    return { advanced, complete };
}

/** Nudge when disk shows progress but the active step hasn't auto-advanced for 2+ turns. */
function buildStalePlanStepNudge(plan, projectRoot, filesTouched, goal, turnsOnStep) {
    if (!plan?.steps?.length || (turnsOnStep || 0) < 2) return '';
    const cur = currentStep(plan);
    if (!cur || cur.status !== 'active') return '';
    const idx = (plan.currentStepIndex ?? 0) + 1;
    const hints = [];
    if (fileExists(projectRoot, 'index.html') && /\bhtml\b/i.test(cur.title)) {
        hints.push('index.html is on disk');
    }
    if (fileExists(projectRoot, 'script.js') && /\bscript|javascript|logic/i.test(cur.title)) {
        hints.push('script.js is on disk');
    }
    if (!hints.length && !isStepSatisfied(cur.title, projectRoot, filesTouched, goal)) return '';
    return [
        '[HARNESS — PLAN STEP]',
        `Step ${idx} ("${cur.title}") looks complete or stalled (${turnsOnStep} turns on this step).`,
        hints.length ? `Detected: ${hints.join('; ')}.` : 'Move on to the next deliverable.',
        'Continue with the NEXT file or feature — or call mark_code_step_done if this step is finished.'
    ].join(' ');
}

/** Nudge when all plan steps are done but gate blockers remain — stop read loops. */
function buildPlanCompleteGateNudge(goal, projectRoot, gateMessages) {
    const blockers = gateMessages?.length
        ? gateMessages
        : collectPlanBlockers(projectRoot, goal).messages;
    if (!blockers.length) return '';
    const dom = blockers.filter(m => /^\[DOM\]/i.test(m)).slice(0, 6);
    const artifact = blockers.filter(m => /^\[ARTIFACT\]/i.test(m));
    const lines = [
        '[HARNESS — PLAN COMPLETE, VERIFICATION BLOCKED]',
        'All plan steps are checked off but the app is NOT ready. Fix these blockers — do NOT read_file in a loop:',
        '',
        ...blockers.slice(0, 8).map(m => `  ${m}`),
        ''
    ];
    if (dom.length) {
        lines.push('Patch script.js so every getElementById id matches index.html (kebab-case). Do NOT rewrite index.html.');
    }
    if (artifact.some(m => /README/i.test(m))) {
        lines.push('Write README.md with title, how to open index.html, and feature list.');
    }
    lines.push('Use patch or write_file — one targeted fix per turn, not repeated reads.');
    return lines.join('\n');
}

module.exports = {
    isStepSatisfied,
    autoAdvancePlanSteps,
    buildStalePlanStepNudge,
    buildPlanCompleteGateNudge,
    collectPlanBlockers,
    planProgressPayload,
    planAllStepsDone,
    domContractClean,
    goalRequiresReadme,
    fileExists
};
