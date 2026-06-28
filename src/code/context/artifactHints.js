/**
 * Hints for "create new app/game in an existing repo" — avoid editing the host app's index.html.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { collectBadRefsFromHtml, buildRepairPlanLines, htmlRelForRefs } = require('../governor/repairPlan.js');

/** Task asks for a new deliverable (game, site, app) rather than editing the host project. */
function goalImpliesNewArtifacts(goal) {
    const t = String(goal || '').toLowerCase();
    if (!/\b(create|build|scaffold|make|write|develop)\b/.test(t)) return false;
    return /\b(game|app|website|web[\s-]?based|web[\s-]?app|pac-?man|site|page|demo|preview)\b/.test(t);
}

function suggestArtifactSubdir(goal) {
    const t = String(goal || '').toLowerCase();
    if (/pac-?man/.test(t)) return 'pacman';
    if (/\bgame\b/.test(t)) return 'game';
    if (/\b(site|website|page)\b/.test(t)) return 'site';
    return 'app';
}

/** Workspace looks like Electron / desktop host (not a static web game root). */
function detectAppRepo(projectRoot) {
    try {
        const pkgPath = path.join(projectRoot, 'package.json');
        if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
            if (deps.electron) return true;
            if (pkg.main && /main\.js|electron/i.test(String(pkg.main))) return true;
        }
        if (fs.existsSync(path.join(projectRoot, 'main.js'))
            && fs.existsSync(path.join(projectRoot, 'index.html'))) {
            return true;
        }
    } catch (e) { /* non-fatal */ }
    return false;
}

function goalWantsPreview(goal) {
    return /\b(show|open|display|launch)\b.*\bpreview\b|\bpreview\b/i.test(String(goal || ''));
}

/** Bootstrap / gate nudge when building a new web artifact inside an app repo. */
function buildNewArtifactBlock(goal, projectRoot) {
    if (!goalImpliesNewArtifacts(goal)) return '';
    const sub = suggestArtifactSubdir(goal);
    const lines = [
        '',
        '[NEW ARTIFACT — do not edit the host app]',
        `Create a self-contained web deliverable under \`${sub}/\`: ${sub}/index.html, ${sub}/style.css, ${sub}/script.js.`,
        'Link CSS/JS in HTML. Use backticks for JS template literals. CSS class names must match JS classList usage.'
    ];
    if (detectAppRepo(projectRoot)) {
        lines.push(
            `This workspace is an Electron/app repo — the root index.html is NOT your game. Write under \`${sub}/\` only.`
        );
    }
    if (goalWantsPreview(goal)) {
        lines.push(`After the files exist, call show_preview with path \`${sub}/index.html\`.`);
    }
    lines.push(
        `All three files must live as siblings inside \`${sub}/\` — link as href="style.css" and src="script.js" (a bare same-folder name, not a path from the root index.html, and not split across other folders like src/).`,
        'Start with write_file now — do not read the root index.html unless you are patching an existing file in this artifact.'
    );
    return lines.join('\n');
}

/** True only when the goal is actually a game (so game-specific hints stay scoped). */
function goalIsGame(goal) {
    return /\b(game|pac-?man|snake|tetris|breakout|pong|arcade|maze|invaders|flappy|platformer|playable)\b/i.test(String(goal || ''));
}

/** Urgent system nudge after the completion gate blocks with zero writes. */
function buildWriteNudge(goal, projectRoot) {
    const sub = suggestArtifactSubdir(goal);
    const preview = goalWantsPreview(goal) ? `\n4. show_preview path="${sub}/index.html"` : '';
    const jsDesc = goalIsGame(goal)
        ? 'the complete game: state, input, loop, win/lose'
        : 'the complete app logic (state, event handlers, persistence, rendering)';
    return [
        '[HARNESS — WRITE REQUIRED]',
        'You stopped without creating files. Respond with tool calls ONLY (no prose).',
        `Required sequence (all files as siblings in the SAME folder \`${sub}/\`):`,
        `1. write_file path="${sub}/index.html" — complete HTML linking style.css and script.js`,
        `2. write_file path="${sub}/style.css" — the complete stylesheet`,
        `3. write_file path="${sub}/script.js" — ${jsDesc}${preview}`,
        detectAppRepo(projectRoot)
            ? `Do NOT patch the root index.html — it belongs to the host app.`
            : `Create all three files before stopping again.`
    ].join('\n');
}

/** Urgent nudge when HTML exists but linked CSS/JS files are missing. */
function buildMissingRefsNudge(missingRefs, goal, projectRoot) {
    const refs = [...new Set((missingRefs || []).filter(Boolean))].map(r => String(r).replace(/\\/g, '/'));
    if (!refs.length) return '';
    const dir = path.posix.dirname(refs[0]);
    const dirHint = dir && dir !== '.' ? `${dir}/` : '';
    // Existing-but-broken linked files (e.g. a .css that contains HTML) need FIX, not CREATE.
    const bad = projectRoot ? collectBadRefsFromHtml(projectRoot, htmlRelForRefs(refs)) : [];
    const planLines = buildRepairPlanLines(refs, bad);
    const preview = goalWantsPreview(goal) ? `\nAfter every file exists and the page loads with no errors: show_preview path="${dirHint}index.html".` : '';
    const gameHint = goalIsGame(goal)
        ? '\nFor a game .js: include keyboard input, score updates, a game loop, and win/lose logic.'
        : '';
    return [
        '[HARNESS — REPAIR, DO NOT RESTART]',
        'index.html is already correct — do NOT rewrite any .html file. Build/fix the files it links so the page works. '
            + 'You MAY emit several write_file/patch calls in THIS one turn:',
        ...planLines,
        // The common failure is putting the file in a different folder or under a bare
        // name. The referenced files must be siblings of the HTML that links them.
        `Write each at EXACTLY its path${dirHint ? ` (same folder \`${dirHint}\` as the HTML)` : ''} with COMPLETE working code — `
            + 'no placeholders or stubs, never a bare filename or another directory, and never HTML inside a .js/.css file.'
            + gameHint,
        'Respond with tool calls only — no prose.',
        preview
    ].filter(Boolean).join('\n');
}

/** After harness recovery — keep the run going (preview / verify), do not treat as done. */
function buildContinueAfterRecoveryNudge(goal, htmlRel, previewOpened) {
    const sub = suggestArtifactSubdir(goal);
    const html = htmlRel || `${sub}/index.html`;
    const noun = goalIsGame(goal) ? 'game' : 'app';
    const lines = [
        '[CONTINUE — run still active]',
        'Recovery finished. Do not stop or replan from scratch.',
        'Do NOT rewrite existing files unless fixing a validation error.'
    ];
    if (goalWantsPreview(goal) && !previewOpened) {
        lines.push(`NEXT (one tool call): show_preview kind=project_file target="${html}"`);
    } else if (goalWantsPreview(goal)) {
        lines.push(`Preview was opened. Reply briefly that the ${noun} is ready.`);
    } else {
        lines.push(`Reply briefly that the ${noun} is ready — no further writes needed.`);
    }
    return lines.join('\n');
}

module.exports = {
    goalImpliesNewArtifacts,
    goalIsGame,
    suggestArtifactSubdir,
    detectAppRepo,
    goalWantsPreview,
    buildNewArtifactBlock,
    buildWriteNudge,
    buildMissingRefsNudge,
    buildContinueAfterRecoveryNudge
};
