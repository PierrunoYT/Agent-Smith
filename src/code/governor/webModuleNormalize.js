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

module.exports = { stripEsModuleSyntax, htmlIsClassic, normalizeClassicScriptModules };
