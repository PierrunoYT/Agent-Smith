'use strict';

// Repair the single most common local-model web mistake (seen even on coder models):
// writing ES-module syntax (import/export) in .js files that index.html loads as CLASSIC
// <script src> (no type="module"). That throws "Unexpected token 'export'" /
// "Cannot use import statement outside a module" and the app doesn't run.
//
// Rather than hope the model fixes it, Code Mode strips the module syntax so each file is
// a valid classic script that shares state via the global lexical scope (top-level
// function/const/let/class are visible to later <script> tags in the same document).
// Only acts when index.html is classic; proper ES-module apps (type="module") are untouched.

const fs = require('fs');
const path = require('path');
const wv = require('./webValidators.js');

/** Strip ES-module syntax, turning a module file into a valid classic script. Pure. */
function stripEsModuleSyntax(code) {
    const before = String(code);
    let s = before;
    // `import ... from '...';` and bare `import '...';`  (whole line)
    s = s.replace(/^[ \t]*import\b[^\n]*?from\s*['"][^'"]+['"][ \t]*;?[ \t]*$/gm, '');
    s = s.replace(/^[ \t]*import\s*['"][^'"]+['"][ \t]*;?[ \t]*$/gm, '');
    // standalone `export { ... };` or `export { ... } from '...';`
    s = s.replace(/^[ \t]*export\s*\{[^}]*\}[ \t]*(?:from\s*['"][^'"]+['"])?[ \t]*;?[ \t]*$/gm, '');
    // `export default function|class` -> declaration ; `export <decl>` -> <decl>
    s = s.replace(/^([ \t]*)export\s+default\s+(?=(?:async\s+)?(?:function|class)\b)/gm, '$1');
    s = s.replace(/^([ \t]*)export\s+(?=(?:async\s+)?(?:function|class|const|let|var)\b)/gm, '$1');
    return { code: s, changed: s !== before };
}

/** True when index.html loads a script via classic <script src> with no type="module". */
function htmlIsClassic(html) {
    const h = String(html || '');
    if (!/<script\b[^>]*\bsrc\s*=/i.test(h)) return false;
    return !/<script\b[^>]*\btype\s*=\s*["']module["']/i.test(h);
}

/**
 * If index.html uses classic scripts, strip module syntax from its referenced local .js
 * files so the app runs. Returns the list of repaired file paths (relative to root).
 */
function normalizeClassicScriptModules(projectRoot, htmlRel) {
    const fixed = [];
    try {
        const htmlAbs = path.join(projectRoot, htmlRel);
        const html = fs.readFileSync(htmlAbs, 'utf8');
        if (!htmlIsClassic(html)) return fixed;
        const { scripts } = wv.extractHtmlRefs(html);
        const htmlDir = path.dirname(htmlAbs);
        for (const ref of scripts || []) {
            if (/^https?:/i.test(ref)) continue;
            const abs = path.resolve(htmlDir, String(ref).replace(/^\.\//, ''));
            if (!/\.m?js$/i.test(abs) || !fs.existsSync(abs)) continue;
            const orig = fs.readFileSync(abs, 'utf8');
            if (!/^[ \t]*(import|export)\b/m.test(orig)) continue; // nothing to strip
            const { code, changed } = stripEsModuleSyntax(orig);
            if (changed) {
                fs.writeFileSync(abs, code, 'utf8');
                fixed.push(path.relative(projectRoot, abs).split(path.sep).join('/'));
            }
        }
    } catch (e) { /* non-fatal */ }
    return fixed;
}

/** Names referenced as `window.NAME` across the given text blobs. */
function collectWindowRefs(texts) {
    const refs = new Set();
    const re = /\bwindow\.([A-Za-z_$][\w$]*)/g;
    for (const t of texts) {
        let m;
        while ((m = re.exec(String(t || '')))) refs.add(m[1]);
    }
    return refs;
}

/** Top-level (column-0) declaration names in a classic script. */
function topLevelDecls(code) {
    const names = new Set();
    const src = String(code || '');
    let m;
    const fnCls = /^(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/gm;
    while ((m = fnCls.exec(src))) names.add(m[1]);
    const vars = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm;
    while ((m = vars.exec(src))) names.add(m[1]);
    return names;
}

/** Remove `type="module"` from every <script src> tag (downgrade to classic). */
function downgradeModuleTags(html) {
    return String(html).replace(
        /(<script\b[^>]*?)\s+type\s*=\s*["']module["']([^>]*>)/gi,
        '$1$2'
    );
}

/**
 * Make a multi-file vanilla web app reliably runnable, regardless of how the model wired it.
 * Handles the two failure classes seen on local/coder models:
 *   1. classic <script> + ES-module syntax (import/export) -> strip the syntax.
 *   2. type="module" + code that relies on `window.X` globals (e.g. `const App = {}` used as
 *      `window.App`) -> module scope means window.App is never set, so the app dies on load.
 *      Downgrade the tags to classic AND expose referenced top-level decls as window globals.
 *
 * REAL ES-module apps (files that import each other) are left untouched — they work over HTTP.
 * Returns the list of repaired files (relative paths). Pure I/O; safe to call repeatedly.
 */
function normalizeWebProject(projectRoot, htmlRel) {
    const fixed = [];
    try {
        const htmlAbs = path.join(projectRoot, htmlRel);
        let html = fs.readFileSync(htmlAbs, 'utf8');
        const { scripts } = wv.extractHtmlRefs(html);
        const htmlDir = path.dirname(htmlAbs);

        const jsAbs = [];
        for (const ref of scripts || []) {
            if (/^https?:/i.test(ref)) continue;
            const abs = path.resolve(htmlDir, String(ref).replace(/^\.\//, ''));
            if (/\.m?js$/i.test(abs) && fs.existsSync(abs)) jsAbs.push(abs);
        }
        if (!jsAbs.length) return fixed;

        const sources = jsAbs.map(a => fs.readFileSync(a, 'utf8'));

        // Real ES-module app? (a local file imports another) -> leave it alone.
        const hasRelImport = sources.some(s =>
            /^[ \t]*import\b[^\n]*from\s*['"]\.{0,2}\/[^'"]+['"]/m.test(s));
        if (hasRelImport) return fixed;

        // Globals-based app: which window.X names does it reference (html inline + all js)?
        const windowRefs = collectWindowRefs([html, ...sources]);

        // 1. Downgrade any type="module" script tags to classic.
        const newHtml = downgradeModuleTags(html);
        const htmlChanged = newHtml !== html;
        if (htmlChanged) html = newHtml;

        // 2. Per file: strip stray module syntax, then expose referenced top-level decls on window.
        for (let i = 0; i < jsAbs.length; i++) {
            const orig = sources[i];
            let { code } = stripEsModuleSyntax(orig);
            const decls = topLevelDecls(code);
            const already = collectAssignedWindow(code);
            const expose = [...decls].filter(n => windowRefs.has(n) && !already.has(n));
            if (expose.length) {
                code = code.replace(/\s*$/, '\n')
                    + expose.map(n => `window.${n} = ${n};`).join('\n') + '\n';
            }
            if (code !== orig) {
                fs.writeFileSync(jsAbs[i], code, 'utf8');
                fixed.push(path.relative(projectRoot, jsAbs[i]).split(path.sep).join('/'));
            }
        }
        if (htmlChanged) fs.writeFileSync(htmlAbs, html, 'utf8');
    } catch (e) { /* non-fatal */ }
    return fixed;
}

/** Names already assigned via `window.NAME = ...` in a file (avoid duplicate exposure). */
function collectAssignedWindow(code) {
    const set = new Set();
    const re = /\bwindow\.([A-Za-z_$][\w$]*)\s*=/g;
    let m;
    while ((m = re.exec(String(code || '')))) set.add(m[1]);
    return set;
}

module.exports = {
    stripEsModuleSyntax, htmlIsClassic, normalizeClassicScriptModules,
    normalizeWebProject, collectWindowRefs, topLevelDecls, downgradeModuleTags
};
