/**
 * Command safety policy — a default-deny blocklist for catastrophic shell commands.
 *
 * The harness auto-runs `run_command` with no interactive confirmation, so a model
 * mistake (or prompt injection) could otherwise wipe a disk or pull-and-exec from the
 * internet. This is NOT a sandbox; it is a guardrail that refuses the clearly-destructive
 * patterns outright. Anything not matched is allowed (the project root + path policy are
 * the real containment for file effects).
 */
'use strict';

// Each rule: { re, reason }. Matched case-insensitively against the normalized command.
const RULES = [
    // Recursive force-delete of a root / home / wildcard root
    { re: /\brm\s+(?:-[a-z]*\s+)*-?[a-z]*r[a-z]*f?[a-z]*\b[^\n]*\s(?:\/|~|\/\*|\$HOME|\$\{HOME\})(?:\s|$)/i, reason: 'recursive delete of a root/home directory' },
    { re: /\brm\s+-[rf]+\s+\/(?:\s|$)/i, reason: 'rm -rf /' },
    // Windows mass delete / format
    { re: /\b(?:del|erase)\b[^\n]*\/[sq][^\n]*[a-z]:\\/i, reason: 'recursive Windows delete of a drive root' },
    { re: /\b(?:rd|rmdir)\b[^\n]*\/s[^\n]*[a-z]:\\?/i, reason: 'recursive Windows directory removal of a drive' },
    { re: /\bformat\s+[a-z]:/i, reason: 'disk format' },
    { re: /\bcipher\s+\/w/i, reason: 'secure-wipe (cipher /w)' },
    // Filesystem / device destruction
    { re: /\bmkfs(\.\w+)?\b/i, reason: 'filesystem creation (mkfs)' },
    { re: /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|disk|hd|vd)/i, reason: 'dd writing to a raw disk device' },
    { re: />\s*\/dev\/(sd|nvme|disk|hd|vd)/i, reason: 'redirect into a raw disk device' },
    // Permission/ownership nukes on root
    { re: /\bchmod\s+-R\s+[0-7]{3,4}\s+\/(?:\s|$)/i, reason: 'recursive chmod of /' },
    { re: /\bchown\s+-R\b[^\n]*\s\/(?:\s|$)/i, reason: 'recursive chown of /' },
    // Fork bomb
    { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: 'fork bomb' },
    // Pull-and-execute straight from the internet — pipe to interpreter
    { re: /\b(?:curl|wget|iwr|invoke-webrequest|irm|invoke-restmethod)\b[^\n]*\|\s*(?:sudo\s+|exec\s+|env\s+)?(?:sh|bash|zsh|dash|source|powershell|pwsh|python\d?|node|ruby|perl|iex|invoke-expression)\b/i, reason: 'piping a remote download straight into an interpreter' },
    { re: /\b(?:iex|invoke-expression)\b[^\n]*(?:downloadstring|downloadfile|webclient|invoke-webrequest|invoke-restmethod|iwr|irm|curl|wget)/i, reason: 'IEX of a remote download (PowerShell)' },
    // Two-step: download a script file, then execute it with an interpreter
    { re: /\b(?:curl|wget)\b[^\n]*(?:-o\s+|--output\s+|-O\s+|>\s*)\S+\.(?:sh|bash|zsh|dash|py|rb|pl|js)\b[^\n]*(&&|;)[^\n]*\b(?:sh|bash|zsh|dash|source|python\d?|node|ruby|perl)\b/i, reason: 'downloading a remote script then executing it with an interpreter' },
    // Power state
    { re: /\b(?:shutdown|reboot|poweroff|halt|init\s+0|init\s+6)\b/i, reason: 'host power-state change' },
];

/**
 * @param {string} command
 * @returns {{ allowed: boolean, reason?: string }}
 */
function assessCommand(command) {
    const cmd = String(command || '').replace(/\s+/g, ' ').trim();
    if (!cmd) return { allowed: true };
    for (const rule of RULES) {
        if (rule.re.test(cmd)) return { allowed: false, reason: rule.reason };
    }
    return { allowed: true };
}

/** Build the tool-result error a blocked command should return to the model. */
function blockedResult(command, reason) {
    return {
        error: `Command blocked by safety policy (${reason}). This destructive command will not run. ` +
            'If you need to remove files, delete specific paths inside the project root instead, or ask the user to run it manually.',
        commandBlocked: true,
        reason
    };
}

module.exports = { assessCommand, blockedResult, RULES };
