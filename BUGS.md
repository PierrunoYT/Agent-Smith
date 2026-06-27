# Known Findings

Documented security/design findings that have been reviewed and intentionally
left as-is (by-design), or are pending a decision. Each entry records the
finding, the assessment, and the rationale so future audits can see the
reasoning rather than re-deriving it.

---

## MEDIUM — Agent Mode whole-host file write/delete

**Source:** external security scan (`AGENTS.md` / `main.js`).
**Status:** by-design. Reviewed 2026-06-27. No code change.

### Finding

Agent Mode explicitly allows whole-host file read/write/delete across the
entire filesystem. `pathPolicy` (`src/shared/pathPolicy.js`) refuses only
"catastrophic targets" — wiping a critical system or home root (`/`, `/etc`,
`/usr`, `/home`, `C:\Windows`, `C:\Users`, the user profile, …) — and allows
every other mutation, including editing or deleting a specific file inside
those directories. A malicious or confused model could therefore delete user
data outside the project workspace. Trust relies on the action log
(`changeLedger` + **Revert All** / `undo_action`) rather than filesystem
containment.

### Assessment

This is the **documented, intended trust model** of Agent Mode, not an
implementation bug:

- `AGENTS.md` states: *"Agent mode manages the whole host; safety is
  guardrail-based — `commandPolicy` screens shell commands and `pathPolicy`
  screens file mutations, refusing only catastrophic targets (wiping a
  system/home root)."*
- `src/shared/pathPolicy.js` header comment states: *"This is NOT a sandbox —
  it refuses only the clearly-catastrophic targets (wiping a critical
  system/home root) and allows everything else, including editing individual
  files under /etc, /usr, etc."*
- `tests/pathPolicy.test.js` explicitly pins the permissive behavior:
  - `assessPathMutation('/etc/myapp.conf', 'write').allowed === true`
  - `assessPathMutation(path.join(os.homedir(), 'notes.txt'), 'delete').allowed === true`

The product purpose of Agent Mode is "manage the whole computer" (host-level
file editing, service management, etc.). Tightening `pathPolicy` into a
project-root sandbox would break that stated purpose and the pinned tests.
The intended mitigation — every consequential mutation is logged to
`actionLog` and reversible ones can be undone via `undo_action` /
`review_actions` / the sidebar **AGENT ACTIONS** panel — is the trust layer
the design relies on by choice.

### Why no code change now

Unlike the sudo shell-injection fix (`1561a04`) and the GPUCache containment
guard (`90acab6`), which were unambiguous implementation bugs, this finding
flags the product's core trust model. Changing it is a product decision with
real UX trade-offs, not a bug fix. Options were reviewed:

1. **Tighten recursive deletes outside project root** — refuse `rm -r` on
   directories outside the project unless on an explicit user-approved list.
   Narrows the "confused model wipes a user folder" risk while preserving
   single-file host management.
2. **Add an opt-in containment mode** — a setting (default off) restricting
   write/delete to the project root + a user-managed allowlist. Additive; no
   existing behavior change.
3. **Require user confirmation for any delete outside the project root** —
   strongest UX mitigation, but changes Agent Mode's flow and needs new IPC +
   renderer UI.

None was applied because each changes documented behavior and should be a
deliberate product call, not an autonomous edit. Re-open this entry if/when a
direction is chosen.

### Related code

- `src/shared/pathPolicy.js` — the guardrail (`assessPathMutation`,
  `criticalRoots`, `blockedPathResult`).
- `src/shared/commandPolicy.js` — the shell-side guardrail.
- `src/main/ipc/agent.js` — `agent-write-file` (line ~249), `agent-delete-file`
  (line ~282) call `assessPathMutation` before mutating.
- `src/main/services/actionLog.js` — the audit + undo trust layer.
- `tests/pathPolicy.test.js`, `tests/harness-security/security.test.js` —
  pinned behavior.
- `AGENTS.md` — "What this is" / "Tool permissions" / trust-layer notes.

---

## MEDIUM — Shell command execution via child_process without strict input validation

**Source:** external security scan (`main.js`).
**Status:** by-design (model-controlled paths) / false positive (static commands).
Reviewed 2026-06-27. No code change.

### Finding

The app uses `exec`, `execSync`, and `spawn` throughout `main.js` for GPU
detection, hardware optimization, and tool execution. The scanner flags that
`commandPolicy` is a denylist (not strict validation) and that models can
request arbitrary shell commands in Agent Mode, creating risk if the denylist
is incomplete.

### Assessment

The finding conflates two unrelated categories of `child_process` usage:

**1. Static hardcoded commands — false positive.**

Lines 58 (`lspci | grep …`), 79 (`Get-CimInstance Win32_VideoController`),
462 (`nvidia-smi …`), 503-513 (`pkill`/`taskkill` for backend restart),
524 (`sudo … systemctl restart ollama`), 537-541 (`taskkill` Windows),
1017/1020 (cloudflared download), 1032 (cloudflared spawn) are all **hardcoded
string literals**. No user or model input flows into them. The paths and URLs
are derived from internal constants (`path.join(app.getPath('cache'), …)`,
hardcoded GitHub release URLs). Flagging `execSync('lspci | grep …')` as
"models can request arbitrary shell commands" is incorrect — these are
app-internal startup/diagnostic commands, not agent tool calls.

**2. Model-controlled command paths — by-design.**

Two paths accept model-controlled commands:

- `runCommandForPlugin` (`main.js:625`) — plugin `shell` capability, gated by
  `assessCommand()` before `exec`.
- `agent-run-command` (`src/main/ipc/agent.js:100`) — Agent Mode
  `run_shell_command` tool, gated by `assessCommand()` before `exec`/`spawn`.

Both are screened by `commandPolicy.js`, which is an explicit denylist, not
strict allowlist validation. This is the **documented design**:
`commandPolicy.js` header states: *"This is NOT a sandbox; it is a guardrail
that refuses the clearly-destructive patterns outright. Anything not matched
is allowed (the project root + path policy are the real containment for file
effects)."*

The scanner's concern ("risk if the denylist is incomplete") is the same
trust-model question as the Agent Mode whole-host finding above. Agent Mode is
designed to "manage the whole computer" — a strict allowlist would break that.
The denylist catches the catastrophic patterns (recursive root deletes, disk
formats, `dd` to raw devices, fork bombs, pull-and-exec, power state changes)
and the action log provides audit + undo for everything else.

### Why no code change now

- Static commands: nothing to fix — no injection surface (no external input).
- Model-controlled paths: same trust-model decision as the Agent Mode
  whole-host finding. Changing from denylist to allowlist would break the
  documented purpose of Agent Mode and is a product decision, not a bug fix.
  See the "Agent Mode whole-host file write/delete" entry above for the three
  mitigation options that were considered.

### Related code

- `src/shared/commandPolicy.js` — the denylist (`RULES`, `assessCommand`,
  `blockedResult`).
- `src/main/ipc/agent.js:100` — `agent-run-command` handler, calls
  `assessCommand` before `exec`/`spawn`.
- `main.js:625` — `runCommandForPlugin`, calls `assessCommand` before `exec`.
- `main.js:58, 79, 462, 503-513, 524, 537-541, 1017, 1020, 1032` — static
  hardcoded commands (no external input).
- `tests/harness-security/security.test.js` — `commandPolicy` rules tested.
