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

---

## MEDIUM — Optional dependencies installed post-distribution via IPC (plugin system)

**Source:** external security scan (`package.json` / `main.js`).
**Status:** by-design. Reviewed 2026-06-27. No code change.

### Finding

The plugin system allows installing packages from arbitrary GitHub URLs or
npm package names at runtime via the `plugin-install-url` input field. Plugins
run as trusted in-process code by default, equivalent to `npm install` from an
untrusted source. While a content hash is recorded for integrity, this does
not prevent malicious code from executing on first enable.

### Assessment

The finding accurately describes the system. This is the **documented,
intentional trust model**, not an oversight:

- `AGENTS.md` states: *"Plugins are trusted code; enabling one records a
  content hash — a later change quarantines it until re-enabled. An opt-in OS
  sandbox (`AGENT_SMITH_PLUGIN_SANDBOX=1`) runs plugin tools in a child
  process under Node's permission model (no `child_process`/`worker`, fs
  scoped to the project). Default is in-process."*
- `pluginIntegrity.js` header: *"This is NOT code signing (no author
  identity) and NOT a sandbox — it is tamper-evidence for the trusted-code
  model: 'the bytes you approved are the bytes that run'."*
- `pluginSandbox.js` header: *"Opt-in: pluginManager enables this only when
  constructed with { sandbox:true } or with AGENT_SMITH_PLUGIN_SANDBOX=1. The
  default (in-process) path is unchanged."*

Two mitigations are already implemented:

1. **Tamper-evidence** (`pluginIntegrity.js`) — SHA-256 over every code/manifest
   file in the plugin dir, recorded on first enable. On every later `discover()`,
   the hash is recomputed; a mismatch quarantines the plugin until the user
   re-enables it. This catches post-install tampering and auto-pulled updates,
   turning them into an explicit re-consent step. It does NOT prevent malicious
   code from running on first enable — that is the trusted-code trade-off.

2. **Opt-in OS sandbox** (`pluginSandbox.js`) — when enabled, plugin tools run
   in a forked child process under Node's Permission Model (`--permission`):
   `child_process` and `worker_threads` are denied, fs is granted only for the
   plugin dir (read) and project root (read/write). Async capabilities
   (shell/net/memory) are brokered back to the parent. Default is OFF; on any
   infra failure it falls back to in-process so functionality is preserved.

The installer (`pluginInstaller.js`) also has:
- SSRF protection via `netGuard.validatePublicFetchTarget` (blocks
  metadata/link-local/ULA hosts).
- Path traversal protection (`path.relative` check on the plugin id, line 145).
- Manifest validation (id format, plugin.json presence).

### Why no code change now

Making the sandbox the default would change the documented behavior and risk
breaking existing plugins that depend on in-process access (e.g. direct fs
outside the project root, or Node APIs restricted under the Permission Model).
The fallback-to-in-process behavior means the sandbox can't be forced without
potentially degrading functionality silently. Flipping the default is a
product decision that needs user testing, not an autonomous edit.

The scanner's core observation — "equivalent to npm install from an untrusted
source" — is correct and is the explicit trade-off the design makes. The
mitigations (hash + opt-in sandbox + SSRF guard + path traversal guard) reduce
the blast radius; they do not eliminate the first-enable trust requirement,
which is by design.

### Considered options (not applied)

1. **Default sandbox on** — flip `AGENT_SMITH_PLUGIN_SANDBOX` default to true.
   Strongest mitigation, but risks breaking existing plugins and needs testing
   against the Electron fork + Node Permission Model interaction.
2. **Code signing / allowlist** — only allow plugins from a curated registry
   or signed by a trusted key. Eliminates the "arbitrary GitHub URL" risk but
   adds infrastructure and friction; changes the product from open to gated.
3. **User confirmation dialog before first enable** — prompt the user with the
   plugin's requested capabilities before running its code. Doesn't prevent
   malicious execution but adds a friction step. Additive, lower risk.

### Related code

- `src/main/services/pluginManager.js` — discovery, registry, enable/cap
  gating, sandbox toggle (line 54).
- `src/main/services/pluginInstaller.js` — fetch + validate + install, SSRF
  guard (line 116), path traversal guard (line 145).
- `src/main/services/pluginIntegrity.js` — content hash, tamper detection.
- `src/main/services/pluginSandbox.js` — opt-in OS sandbox (Node Permission
  Model).
- `src/main/ipc/plugins.js:27` — `plugin-install` IPC handler.
- `index.html` — `plugin-install-url` input field.
- `AGENTS.md` — "Plugins" section.

---

# Per-file Bug Audit Checklist

Use this section to scan the codebase batch by batch. For each file, add findings under `Bugs / notes` with severity, repro/impact, and proposed fix.

## Batch 1 — Root / app entrypoints

### `index.html`

**Bugs / notes:**

- TBD

### `main.js`

**Bugs / notes:**

- **LOW — duplicate renderer console logging.** `mainWindow.webContents.on("console-message", ...)` is registered twice in a row, so every renderer console message is logged twice. Impact is noisy logs / harder debugging, not a security issue. Fix: remove one duplicate listener. Related code: `main.js:394-395`.
- **MEDIUM — unbounded `/api/invoke` request body accumulation.** The mobile/web IPC proxy concatenates request chunks into `body` with no maximum size before `JSON.parse`. A LAN/web client, and potentially a Cloudflare tunnel client, can send a huge POST body and force memory growth. Fix: enforce a small max body size and return `413 Payload Too Large` / destroy the request once exceeded. Related code: `main.js:872-879`.
- **MEDIUM — unauthenticated static source disclosure for any `.js` / `.css` / image path.** The auth gate treats any URL ending in `.js`, `.css`, `.png`, or `.jpg` as public, then static serving allows any contained path under the app directory. This likely lets unauthenticated LAN/web clients fetch backend source such as `src/main/ipc/auth.js`, `src/main/services/auth.js`, or `src/shared/commandPolicy.js` before login. Fix: restrict unauthenticated static files to an explicit login/renderer asset allowlist, not every source file extension. Related code: `main.js:787-803`, `main.js:962-986`.
- **MEDIUM — auto-download and execute moving `cloudflared` binary without integrity verification.** Startup downloads `cloudflared` from GitHub `latest` release URLs and later spawns the downloaded binary, with no pinned version or checksum/signature verification. The URL is hardcoded, so this is not command injection, but it is a supply-chain/trust risk. Fix: pin a version and verify SHA256/signature, or require explicit user consent before first download/run. Related code: `main.js:1006-1033`.

### `preload.js`

**Bugs / notes:**

- TBD

### `replace-tools.js`

**Bugs / notes:**

- **LOW — obsolete/missing legacy-path migration helper appears to fail by default.** The script reads `hotfix2/v41.7/tools.js` and `hotfix2/v41.7/index.js` unconditionally; if those legacy files are not present, it throws before doing anything. This may be an old one-off helper rather than active app code. Fix: remove it if obsolete, or add existence checks and clear usage errors. Related code: `replace-tools.js:3-9`.

### `run.sh`

**Bugs / notes:**

- TBD

### `package.json`

**Bugs / notes:**

- TBD

## Batch 2 — Code Mode: context / planning / session

### `src/code/context/artifactHints.js`

**Bugs / notes:**

- TBD

### `src/code/context/bootstrap.js`

**Bugs / notes:**

- TBD

### `src/code/context/budget.js`

**Bugs / notes:**

- TBD

### `src/code/context/gemmaHarness.js`

**Bugs / notes:**

- TBD

### `src/code/context/phaseCompact.js`

**Bugs / notes:**

- **LOW — phase compaction can drop tool results from multi-tool assistant turns.** `collectRecentToolPairs` only preserves a `tool` message when the immediately previous message is an `assistant` with `tool_calls`. For an assistant turn that emits multiple tool calls followed by multiple `tool` messages, only the first adjacent pair is kept and later tool results are skipped during compaction. This can remove relevant recent tool output at phase transitions. Fix: group all consecutive `tool` messages following each assistant `tool_calls` message, or match by `tool_call_id` when present. Related code: `src/code/context/phaseCompact.js:15-27`.

### `src/code/context/planAnchor.js`

**Bugs / notes:**

- TBD

### `src/code/context/planArtifacts.js`

**Bugs / notes:**

- **MEDIUM — default Final milestone is not parsed as a milestone with verify command.** `defaultPlanContent` writes `- [ ] **Final: all checks pass** — verify: \`harness completion gate\`` without the `| verify:` separator required by `MILESTONE_RE`. Because M1/M2 do match the strict regex, `reloadMilestones` never falls back to `MILESTONE_SIMPLE`, so the Final milestone is omitted entirely from `this.milestones`. Result: long-horizon plans may track only M1/M2 and never expose/advance the final verification milestone. Fix: make the default Final line use `| verify: ...`, or loosen `MILESTONE_RE` to accept both `| verify:` and `— verify:` consistently. Related code: `src/code/context/planArtifacts.js:15-18`, `src/code/context/planArtifacts.js:61-63`, `src/code/context/planArtifacts.js:168-194`.

### `src/code/context/symbolMap.js`

**Bugs / notes:**

- TBD

### `src/code/plan/codePlan.js`

**Bugs / notes:**

- TBD

### `src/code/session/state.js`

**Bugs / notes:**

- TBD

## Batch 3 — Code Mode: governor

### `src/code/governor/acceptance.js`

**Bugs / notes:**

- **MEDIUM — game acceptance can count score initialization as a score update.** `scoreMutated` matches any assignment to `score`, including initial declarations like `let score = 0`, and `scoreShown` passes if an HTML element id contains `score`. A static game with a score element and initial score assignment can pass the `score updates` acceptance check without ever changing or re-rendering score during gameplay. Fix: distinguish initialization from runtime mutation/rendering, e.g. require `score +=`, `score++`, assignment inside an event/loop/collision handler, or DOM text update that references a changed score value. Related code: `src/code/governor/acceptance.js:53-60`.

### `src/code/governor/completionGate.js`

**Bugs / notes:**

- **MEDIUM — web validation follows HTML script/style references outside the project root.** `runValidation` resolves each non-HTTP HTML `script`/`link` reference with `path.resolve(htmlDir, ref)` and later reads those resolved files into `combinedCss` / `combinedJs` if they exist, without checking that the resolved path remains inside `projectRoot`. A generated `index.html` containing `../` references could make Code Mode validation read files outside the workspace, conflicting with Code Mode's project-root containment model. Fix: reject or skip refs whose resolved absolute path is outside `projectRoot`, and report a validation error instead of reading them. Related code: `src/code/governor/completionGate.js:188-217`.

### `src/code/governor/earlyStop.js`

**Bugs / notes:**

- TBD

### `src/code/governor/postEditChecks.js`

**Bugs / notes:**

- TBD

### `src/code/governor/projectRules.js`

**Bugs / notes:**

- **MEDIUM — project-local rule loading executes arbitrary `.agentsmith/rules/*.js` during Code Mode validation.** `loadRules` walks `.agentsmith/rules` and calls `require(abs)` for every `.js` rule file with no signing, prompt, sandbox, or repository trust check. Because Code Mode auto-runs validation, opening/running an untrusted project can execute project-provided JavaScript in the main process. This may be intended for trusted project rules, but it is a high-trust execution path and should be documented/gated like plugins. Fix: disable rules by default for untrusted workspaces, run them in the existing plugin sandbox/child process, or require explicit user consent before first load. Related code: `src/code/governor/projectRules.js:15-49`.

### `src/code/governor/qualityMonitor.js`

**Bugs / notes:**

- TBD

### `src/code/governor/readiness.js`

**Bugs / notes:**

- TBD

### `src/code/governor/smokeTest.js`

**Bugs / notes:**

- **MEDIUM — smoke test follows local script references outside the project root.** `readLocalScripts` resolves every non-HTTP `<script src>` with `path.resolve(htmlDir, rel)` and reads it without verifying that the resolved path stays under `projectRoot`. A generated HTML file with `../` references can make the smoke test read and execute JavaScript outside the workspace in the VM/jsdom smoke environment, violating Code Mode's project-root containment expectation. Fix: reject external-to-root resolved script paths before reading/executing them. Related code: `src/code/governor/smokeTest.js:25-43`, `src/code/governor/smokeTest.js:181-187`, `src/code/governor/smokeTest.js:211-224`.
- **LOW — smoke-test DOM stub masks real missing-element errors.** The VM fallback returns a stub element for any `getElementById` / `querySelector` call, even when the element does not exist in the HTML. This avoids false positives, but it can also hide real bugs where app code expects missing DOM nodes and would throw in a browser. Fix: optionally run a stricter mode after the permissive smoke pass, or only auto-create stubs for known benign selectors. Related code: `src/code/governor/smokeTest.js:88-92`, `src/code/governor/smokeTest.js:128-138`.

### `src/code/governor/webValidators.js`

**Bugs / notes:**

- **LOW — serialization-artifact detector flags legitimate escaped braces in JavaScript strings/regex.** `detectSerializationArtifacts` treats any `\\{` or `\\}` in a text file as corruption. That pattern can be valid JavaScript, especially regex literals or string patterns that intentionally escape literal braces. Because completion validation runs this detector over JS/CSS/HTML, valid code can be blocked as a leaked JSON artifact. Fix: make this check language-aware, avoid applying it to JS regex/string contents, or require stronger surrounding evidence of a tool-call envelope before failing. Related code: `src/code/governor/webValidators.js:455-467`.

## Batch 4 — Code Mode: loop / tools

### `src/code/loop/codeTrace.js`

**Bugs / notes:**

- TBD

### `src/code/loop/finalSummary.js`

**Bugs / notes:**

- TBD

### `src/code/loop/harnessScaffold.js`

**Bugs / notes:**

- TBD

### `src/code/loop/middleware.js`

**Bugs / notes:**

- TBD

### `src/code/loop/milestoneSubagents.js`

**Bugs / notes:**

- **MEDIUM — concurrent milestone worktrees share mutable orchestrator objects.** In `worktree-concurrent` mode, `Promise.all` runs multiple `runOneMilestone` calls with the same `planAnchor`, `planArtifacts`, `earlyStop`, `qualityMonitor`, `trace`, `execDeps`, and `projectContext`. Each child turn loop can append plan artifacts, update shared counters/trace, and temporarily call `projectContext.setRoot(worktreePath)`. Concurrent root switching and shared state mutation can race, causing tools to run against the wrong worktree or corrupt parent run state. Fix: clone/isolate per-child state and avoid global `projectContext.setRoot` during concurrent runs, or disable true concurrency until dependencies are made per-worktree. Related code: `src/code/loop/milestoneSubagents.js:71-120`, `src/code/loop/milestoneSubagents.js:165-167`.
- **LOW — worktree cleanup is skipped when a child turn loop throws.** `cleanupMilestoneWorktree` runs only after `executeTurnLoop` completes successfully and after syncing files. If `executeTurnLoop` throws, the `finally` restores `projectContext` but does not cleanup the created worktree, leaving temporary branches/worktrees behind. Fix: move cleanup into a `finally` guarded by `useWorktree && worktreePath`, preserving sync behavior where possible. Related code: `src/code/loop/milestoneSubagents.js:95-130`.

### `src/code/loop/missingRefGuard.js`

**Bugs / notes:**

- TBD

### `src/code/loop/phases.js`

**Bugs / notes:**

- TBD

### `src/code/loop/planningPhase.js`

**Bugs / notes:**

- **MEDIUM — planning mode can execute write/shell tool calls before user approval.** The planning loop offers only read tools plus `submit_code_plan`, but it executes every non-`submit_code_plan` call returned in `msg.tool_calls` directly through `executeTool` with the full executor dependencies and no phase gate or explicit allowlist. If a model/server returns a native `write_file`, `patch`, `append_file`, or `run_command` call despite the advertised tool list, planning mode can mutate the project or run shell commands before a plan is submitted/approved. Fix: enforce a planning allowlist (`read_file`, `grep`, `glob`, `list_project`, optionally `show_preview`) before `executeTool`, or route planning calls through the same phase middleware. Related code: `src/code/loop/planningPhase.js:29-35`, `src/code/loop/planningPhase.js:84-98`.

### `src/code/loop/reasoningStrip.js`

**Bugs / notes:**

- TBD

### `src/code/loop/runCodeTask.js`

**Bugs / notes:**

- **MEDIUM — isolated Code runs leave the global project root switched to the worktree and skip normal cleanup.** Whole-run isolation creates a git worktree, rewrites `session.projectRoot`, and calls `projectContext.setRoot(wt.path)`, but the normal `executeTurnLoop` path never restores `projectContext` to `parentProjectRoot`. Its cleanup guard also requires `opts.projectRoot`, yet the final `executeTurnLoop({ ... })` call does not pass `projectRoot`, so `cleanupWorktree(...)` is skipped after non-subagent isolated runs. A completed isolated run can therefore leave subsequent app operations pointed at `.agentsmith/worktrees/<session>` instead of the original checkout, with temporary worktrees/branches accumulating. Fix: pass the parent project root into `executeTurnLoop`, restore `projectContext` in a `finally`, and define whether whole-run worktree changes should be synced or intentionally preserved before cleanup. Related code: `src/code/loop/runCodeTask.js:98-100`, `src/code/loop/runCodeTask.js:246-258`, `src/code/loop/runCodeTask.js:407-425`.

### `src/code/loop/runWatchdog.js`

**Bugs / notes:**

- TBD

### `src/code/loop/streamCompletion.js`

**Bugs / notes:**

- TBD

### `src/code/loop/turnLoop.js`

**Bugs / notes:**

- TBD

### `src/code/tools/dedup.js`

**Bugs / notes:**

- TBD

### `src/code/tools/executor.js`

**Bugs / notes:**

- **LOW — malformed `write_file` without content can throw after recording ledger state.** The `write_file` branch validates `path` and calls `checkWriteChunkSize(a.content)`, but it never requires `content` to be a string before taking a change-ledger snapshot/recordCreate and passing `a.content` to `fs.writeFile`. If a model emits `write_file` with a path but missing `content`, `fs.writeFile(..., undefined, 'utf-8')` throws instead of returning a normal tool error, potentially after `recordCreate` has logged a create for a file that was never written. Fix: reject missing/non-string content before any ledger operation, e.g. `if (typeof a.content !== 'string') return { error: 'write_file requires string content' }`. Related code: `src/code/tools/executor.js:214-237`.

### `src/code/tools/extractor.js`

**Bugs / notes:**

- TBD

### `src/code/tools/jsonRepair.js`

**Bugs / notes:**

- TBD

### `src/code/tools/planTools.js`

**Bugs / notes:**

- TBD

### `src/code/tools/router.js`

**Bugs / notes:**

- TBD

### `src/code/tools/schemas.js`

**Bugs / notes:**

- TBD

## Batch 5 — Main process IPC / lifecycle / server

### `src/main/ipc/actions.js`

**Bugs / notes:**

- **LOW — `actions-clear` can erase the Agent Mode audit trail without a scoped confirmation or undo.** The action log is the documented trust layer for Agent Mode, but the IPC handler exposes `actions-clear` as a one-shot call to `log.clear()`, which irreversibly removes every recorded action and its undo metadata. The web permission policy gates `actions-*` behind tool permission, but there is no per-call confirmation, session scoping, or preservation of reversible entries. A model/tool-capable user can therefore wipe the evidence/undo trail that makes Agent Mode reviewable. Fix: remove this channel from model-facing surfaces, require explicit user confirmation in UI, or archive/soft-delete entries while preserving undo data until a retention window expires. Related code: `src/main/ipc/actions.js:12-14`, `src/main/services/actionLog.js:84`.

### `src/main/ipc/agent.js`

**Bugs / notes:**

- **MEDIUM — Agent Mode directory deletes are marked reversible but only recreate an empty directory.** `agent-delete-file` logs an undo object for directories as `{ op:'delete', isDir:true }` after recursively deleting the directory with `fs.rm(..., { recursive:true, force:true })`. `actionLog.undo` handles that by only calling `fs.mkdirSync(u.path, { recursive:true })`, so `undo_action` reports success while all deleted child files remain lost. This undermines the advertised reversible trust layer for directory deletes outside/inside the project. Fix: either mark directory deletes audit-only/non-reversible unless a full tree snapshot is captured, or store/restore a bounded recursive snapshot. Related code: `src/main/ipc/agent.js:282-305`, `src/main/services/actionLog.js:70-72`.

### `src/main/ipc/auth.js`

**Bugs / notes:**

- TBD

### `src/main/ipc/code.js`

**Bugs / notes:**

- **LOW — background Code Mode command spawn failures can crash the main process.** Agent Mode background commands attach a child `error` handler, but Code Mode's equivalent `runBackgroundCommand` does not. If `spawnShell` fails asynchronously (missing shell, invalid cwd, OS error), the unhandled child `error` event can terminate the Electron main process instead of returning/logging a tool failure. Fix: mirror the Agent Mode handler by recording `[Process failed to start: ...]`, setting `running=false`, and returning a failed job result where possible. Related code: `src/main/ipc/code.js:105-120`; contrast `src/main/ipc/agent.js:138-144`.
- **MEDIUM — Code Mode IPC drops isolation and milestone flags before starting runs.** The `code-run` handler reads `isolatedRun`, `parallelMilestones`, `milestoneWorktrees`, and `milestoneConcurrent` from renderer options and passes them into `startCodeTask`, but `startCodeTask` does not copy any of those flags into the `base` object sent to `runCodeTask`. As a result, toggling isolated runs or parallel/milestone worktrees in the UI has no effect on the main execution path; worktree isolation and subagent orchestration can silently stay disabled. Fix: propagate these booleans through `startCodeTask`'s `base`, and preserve them when resuming/approving plans where appropriate. Related code: `src/main/ipc/code.js:149-176`, `src/main/ipc/code.js:213-228`, `src/code/loop/runCodeTask.js:240-258`, `src/code/loop/runCodeTask.js:350-372`.

### `src/main/ipc/edit.js`

**Bugs / notes:**

- TBD

### `src/main/ipc/git.js`

**Bugs / notes:**

- **MEDIUM — `git-undo` can hard-reset unrelated user commits without confirmation or ownership checks.** The IPC handler exposes `git-undo` as a direct call to `gitIntegration.undoLast(projectContext.getRoot())`. The underlying implementation runs `git reset --hard HEAD~1` when a parent commit exists, with no check that the last commit was created by Agent Smith and no dirty-worktree guard. A tool-capable web/renderer caller can therefore discard the user's latest commit and uncommitted working tree changes, not just an Agent Smith checkpoint. Fix: record commit IDs created by Agent Smith and only undo those, refuse when the worktree is dirty unless explicitly confirmed, or use a non-destructive `git revert` flow. Related code: `src/main/ipc/git.js:23`, `src/shared/gitIntegration.js:47-55`.

### `src/main/ipc/history.js`

**Bugs / notes:**

- TBD

### `src/main/ipc/index.js`

**Bugs / notes:**

- TBD

### `src/main/ipc/ledger.js`

**Bugs / notes:**

- **LOW — ledger IPC can throw when no plan/session id is available.** Both `ledger-diff` and `ledger-revert-all` fall back to `state.currentPlanId` when no explicit id is passed, then call `changeLedger.diff/revertAll` unconditionally. If there is no active plan/session, `state.currentPlanId` can be `null`/`undefined`; `ChangeLedger.getLedgerDir(planId)` then passes that value to `path.join`, which throws instead of returning a structured `{ error: 'No active plan' }`. Fix: validate `planId || state.currentPlanId` in the IPC handler before calling the ledger. Related code: `src/main/ipc/ledger.js:11-13`, `src/main/services/changeLedger.js:11-13`, `src/main/services/changeLedger.js:146-188`.

### `src/main/ipc/lmStudio.js`

**Bugs / notes:**

- TBD

### `src/main/ipc/memory.js`

**Bugs / notes:**

- **MEDIUM — memory write/delete IPC is not gated by tool permission.** The shared web permission policy gates `agent-`, `code-`, `git-`, `edit-`, `plugin-`, `ledger-`, `preview-`, and `actions-` channels, but not `mem-*`. As a result, any authenticated web user with `canUseApp` can call `mem-store` to persist arbitrary text into cross-session memory and `mem-clear` to erase all vector memory, even when `canUseTools` is false. The tests only assert `mem-query` is read-only; the mutating memory channels are not distinguished. Fix: add `mem-store` and `mem-clear` (and possibly `mem-count` if memory metadata is sensitive) to `TOOL_CHANNELS` or introduce a dedicated memory permission. Related code: `src/main/ipc/memory.js:9-23`, `src/shared/channelPolicy.js:13-28`, `tests/securityPolicy.test.js:102-110`.

### `src/main/ipc/plugins.js`

**Bugs / notes:**

- TBD

### `src/main/ipc/preview.js`

**Bugs / notes:**

- TBD

### `src/main/ipc/project.js`

**Bugs / notes:**

- TBD

### `src/main/lifecycle/whatsapp.js`

**Bugs / notes:**

- **MEDIUM — WhatsApp send IPC bypasses tool-permission gating.** `whatsapp-send` has a real-world side effect (sending a message) and is exposed as the Agent Mode `send_whatsapp_message` tool, but `whatsapp-*` channels are not included in `TOOL_PREFIXES` or `TOOL_CHANNELS`. Through `/api/invoke`, any authenticated user whose account can use the app can call `whatsapp-send` once WhatsApp is linked, even if `canUseTools` is false. Fix: gate `whatsapp-send` (and likely `whatsapp-init`/`whatsapp-cancel`) behind `canUseTools`, or add an explicit messaging permission/confirmation step. Related code: `src/main/lifecycle/whatsapp.js:134-139`, `src/renderer/modes/agentTools.js:449-451`, `src/shared/channelPolicy.js:13-28`.
- **LOW — failed WhatsApp initialization leaves a stale client object that blocks retry.** `whatsapp-init` assigns `whatsappClient = new Client(...)` before `await whatsappClient.initialize()`. If initialization throws, the catch returns `{ error }` but does not destroy the client or reset `whatsappClient` to `null`. Subsequent `whatsapp-init` calls hit the early `if (whatsappClient) return { status:'already_init' }` path even though the client is not ready, and the failed headless browser/session may remain alive until cancellation or process exit. Fix: in the catch block, destroy the partially-created client and clear `whatsappClient` before returning the error. Related code: `src/main/lifecycle/whatsapp.js:69-83`, `src/main/lifecycle/whatsapp.js:116-121`.

### `src/main/server/previewRoutes.js`

**Bugs / notes:**

- TBD

### `src/main/server/pushEvent.js`

**Bugs / notes:**

- TBD

### `src/main/server/sseHub.js`

**Bugs / notes:**

- TBD

## Batch 6 — Main process services

### `src/main/services/actionLog.js`

**Bugs / notes:**

- **LOW — action log reports success even when persistence fails.** The action log is documented as durable audit/undo storage, but `save()` swallows every `fs.writeFileSync` error and `record()` still returns a fresh id. If the userData directory is non-writable, full, or otherwise failing, Agent Mode can perform consequential actions while the audit trail and undo metadata exist only in memory and disappear on restart, with no warning to the caller/user. Fix: make `save()` return/throw errors and surface persistence failures from `record`, or mark entries as volatile and warn the user that the trust layer is not durable. Related code: `src/main/services/actionLog.js:30`, `src/main/services/actionLog.js:34-48`.

### `src/main/services/auth.js`

**Bugs / notes:**

- TBD

### `src/main/services/browserVerify.js`

**Bugs / notes:**

- **MEDIUM — model-supplied browser verification checks can hang indefinitely.** `browser_verify` accepts arbitrary JavaScript expressions from the model and executes each one with `webContents.executeJavaScript(...)`, but only the page load has a timeout. A check such as `while(true){}` or a never-resolving promise can leave `run()` awaiting forever, preventing the `finally` block from destroying the hidden BrowserWindow and stalling the Code Mode run. Fix: wrap each check in a timeout/Abort-like race, avoid awaiting arbitrary promises, and destroy the window on timeout. Related code: `src/main/services/browserVerify.js:59-70`, `src/main/services/browserVerify.js:74-94`, `src/code/tools/schemas.js:147-158`.

### `src/main/services/changeLedger.js`

**Bugs / notes:**

- **MEDIUM — snapshot failures can turn existing-file edits into destructive revert deletes.** `snapshotBefore` wraps access, file read, and snapshot write in one broad `try/catch`; any failure sets `existed=false` and still records a manifest entry. If the target file exists but reading it or writing the snapshot fails (permissions, EISDIR, disk full, transient IO), the later edit/delete can proceed while `revertAll` treats the path as newly created and unlinks it instead of restoring original content. Directory deletes hit this path because `readFile(directory)` throws, so the ledger cannot restore them but records them as non-existing. Fix: distinguish "target did not exist" from "snapshot failed", abort the mutation on snapshot failure, and mark unsupported directory snapshots as audit-only rather than `existed:false`. Related code: `src/main/services/changeLedger.js:45-70`, `src/main/services/changeLedger.js:187-207`.
- **LOW — created directories are not reverted by Revert All.** `recordCreate` records only a path/action, and `revertAll` removes created entries with `fsPromises.unlink(entry.path)`. If a tool records creation of a directory, or a file creation also creates new parent directories, Revert All cannot remove the directory tree; `unlink` on a directory reports `EISDIR`, and parent directories created solely for the run are left behind. Fix: record entry type (`file`/`dir`) and remove created directories with `rm({recursive:true})`, or track and prune empty parent directories created by file writes. Related code: `src/main/services/changeLedger.js:73-86`, `src/main/services/changeLedger.js:195-201`, `src/code/tools/executor.js:236-237`.

### `src/main/services/editEngine.js`

**Bugs / notes:**

- **LOW — `applyPatch` silently ignores all but the first file in a unified diff.** `applyPatchToFile` parses every file header in a patch but applies only `parsed[0]`, and `EditEngine.applyPatch` writes that result to the separately supplied `filePath`. A multi-file patch can therefore report success while dropping every later file hunk, and a patch whose first header names a different file can be applied to the caller's `filepath` anyway. Fix: reject multi-file patches in `applyPatch`, verify the parsed patch path matches `filePath`, or implement atomic multi-file patch application with per-file ledger snapshots. Related code: `src/main/services/editEngine.js:110-144`, `src/shared/editFormats.js:165-174`.

### `src/main/services/lmStudioManager.js`

**Bugs / notes:**

- **MEDIUM — failed LM Studio context reload can unload the user's working model.** `ensureNow` first runs estimate-only probes, then unloads the currently loaded model, then attempts the real `lms load` for the selected context. If that final load fails (CLI error, transient LM Studio failure, model path issue), the error propagates to IPC after the previous loaded instance has already been unloaded, leaving the user with no working model and no rollback attempt. Fix: load the replacement before unloading when LM Studio supports it, or on load failure retry loading the previously reported `loadedContext`/parallel settings before returning the error. Related code: `src/main/services/lmStudioManager.js:178-193`, `src/main/ipc/lmStudio.js:21-30`.

### `src/main/services/memory.js`

**Bugs / notes:**

- **LOW — memory store/clear report success even when persistence fails.** `saveJSON` returns `false` on write errors, but `storeVector` ignores that return value and still returns `{ success:true }` after pushing the vector in memory; `clearMemory` likewise returns `true` regardless of whether the emptied database was written. If the userData directory is non-writable or full, the UI/model can believe memory was saved or wiped while the change is lost on restart. Fix: propagate `saveJSON` failures from `storeVector`/`clearMemory` and surface a warning to callers. Related code: `src/main/services/memory.js:125-136`, `src/main/services/memory.js:231-244`.

### `src/main/services/pluginHost.js`

**Bugs / notes:**

- TBD

### `src/main/services/pluginInstaller.js`

**Bugs / notes:**

- **HIGH — plugin installation can fetch unpinned, mutable code and execute it after a shallow clone.** `install(url)` accepts arbitrary public git/http URLs, clones the default branch with `git clone --depth 1`, validates only `plugin.json`, and then installs bytes that `pluginManager.discover()` can later `require()` in the main process. GitHub web URLs without `git` fall back to `refs/heads/main`/`master` tarballs. There is no commit SHA pinning, signature check, checksum prompt, or immutable source requirement, so a compromised upstream branch or TOCTOU update between review and install becomes trusted app code. Fix: require immutable commit/tag refs plus a displayed content hash, store source commit/checksum, and refuse branch HEAD installs unless the user explicitly accepts mutable trusted code. Related code: `src/main/services/pluginInstaller.js:114-152`, `src/main/services/pluginManager.js:187-199`, `src/main/services/pluginManager.js:201-224`.
- **LOW — failed plugin downloads leave partial archive files open in staging.** `_httpsDownload` creates a write stream before making the request, but on HTTP errors, redirects beyond the limit, validation failures, or request errors it rejects without closing/destroying the stream or unlinking the partial destination. The outer `finally` removes the staging directory, but an open file descriptor can make cleanup fail on Windows and leave temp data behind. Fix: destroy/close the stream on every failure path and unlink partial files before rejecting. Related code: `src/main/services/pluginInstaller.js:49-67`, `src/main/services/pluginInstaller.js:123-157`.

### `src/main/services/pluginIntegrity.js`

**Bugs / notes:**

- **MEDIUM — plugin integrity hashing ignores non-code assets that can affect runtime behavior.** `hashPluginDir` hashes only `.js`, `.cjs`, `.mjs`, and `.json` files, skipping everything else under the plugin directory. Trusted plugin code can read templates, prompts, binaries, WASM, certificates, or data files at runtime; changing those skipped files after trust-on-enable will not change the trusted hash and will not quarantine the plugin. Fix: hash every file except explicitly ignored bulky/generated directories, or require the manifest to enumerate all runtime assets and include them in the trust hash. Related code: `src/main/services/pluginIntegrity.js:16-29`, `src/main/services/pluginIntegrity.js:37-52`.
- **LOW — unreadable plugin files hash as empty content instead of failing closed.** During hashing, `readFileSync` errors are caught and replaced with an empty string. A transient permissions/IO error can therefore produce a deterministic hash that gets trusted in `setEnabled`, and later restoring file readability changes the bytes again; conversely a malicious local actor can make a file unreadable during re-enable to trust the wrong content set. Fix: propagate read errors and refuse enable/discover trust decisions when any hash input cannot be read. Related code: `src/main/services/pluginIntegrity.js:44-49`, `src/main/services/pluginManager.js:451-456`.

### `src/main/services/pluginManager.js`

**Bugs / notes:**

- **HIGH — plugin command and hook execution bypasses the opt-in sandbox.** `invokeTool` can use `runToolSandboxed` when sandbox mode is enabled, but `runCommandText` and `fireHook` always build an in-process host and call plugin code directly. A plugin can put malicious code in a command or hook contribution and regain full main-process privileges even when the user/admin enabled `AGENT_SMITH_PLUGIN_SANDBOX=1`. Fix: route command and hook contributions through the same sandbox runner or disable commands/hooks when sandbox mode is required. Related code: `src/main/services/pluginManager.js:346-375`, `src/main/services/pluginManager.js:403-436`, `src/main/services/pluginSandbox.js:32-84`.
- **MEDIUM — sandbox infrastructure failures silently fall back to trusted in-process execution.** In `invokeTool`, any sandbox error is logged and the tool is then executed in-process. That means a misconfigured Node permission model, unsupported Electron fork behavior, or malicious plugin that intentionally breaks sandbox startup turns a requested isolation policy into full main-process execution without surfacing failure to the user. Fix: fail closed when sandbox mode is enabled, or require an explicit per-plugin/admin opt-in to fallback. Related code: `src/main/services/pluginManager.js:350-365`, `src/main/services/pluginManager.js:368-375`.
- **LOW — plugin state persistence failures are not converted to structured errors.** `setEnabled` and `uninstall` call `saveState()` directly; if the plugin state file cannot be written, the exception propagates through IPC/web as a generic 500 after in-memory enablement/deletion has already happened. The UI may show a failed request while the current process state changed and will revert on restart. Fix: write state atomically before mutating live registry where possible, catch persistence errors, and return structured failures without partial state changes. Related code: `src/main/services/pluginManager.js:78-81`, `src/main/services/pluginManager.js:441-477`, `src/main/services/pluginManager.js:480-491`.

### `src/main/services/pluginSandbox.js`

**Bugs / notes:**

- TBD

### `src/main/services/pluginSandboxRunner.js`

**Bugs / notes:**

- **LOW — sandbox runner trusts the parent-supplied tool file without an in-child containment check.** `runToolSandboxed` currently passes contribution files discovered by `pluginManager`, which are already scoped to the plugin directory, but the exported runner protocol itself sends only `toolFile` and the child blindly `require(msg.toolFile)`. If future sandboxed command/hook support or a custom caller passes a file outside the plugin directory while also granting project-root fs permissions, the child has no second containment check. Fix: send `pluginDir` to the child, re-check `toolFile` containment in `pluginSandboxRunner`, and reject mismatches before `require`. Related code: `src/main/services/pluginSandbox.js:32-42`, `src/main/services/pluginSandbox.js:79-80`, `src/main/services/pluginSandboxRunner.js:57-70`.

### `src/main/services/previewRunner.js`

**Bugs / notes:**

- **MEDIUM — pending desktop screenshot requests are not bound to the requesting preview.** `show({kind:'screenshot'})` stores a pending preview id for user source selection, but `captureSource` accepts any `sourceId` and will capture it even when `previewId` is missing or not found. A renderer/web caller with preview permission can skip the pick-source flow and request capture of any source id it has learned from `preview-list-sources`, bypassing the pending request/consent association. Fix: require a valid pending `previewId` for non-app desktop captures, verify it has not expired, and delete/deny stale or unknown ids. Related code: `src/main/services/previewRunner.js:121-130`, `src/main/services/previewRunner.js:137-164`, `src/main/ipc/preview.js:34-40`.

### `src/main/services/previewService.js`

**Bugs / notes:**

- **LOW — preview capture viewport is not bounded before creating BrowserWindow.** `captureWebUrl` merges model/user-provided `viewport` directly into `BrowserWindow` dimensions. Extremely large, negative, or non-finite width/height values can throw, allocate excessive GPU/bitmap memory, or destabilize the Electron process during preview capture. Fix: coerce viewport dimensions to finite integers and clamp to a safe min/max before constructing `BrowserWindow`. Related code: `src/main/services/previewService.js:84-96`, `src/main/services/previewRunner.js:66-74`.

### `src/main/services/projectContext.js`

**Bugs / notes:**

- **HIGH — project-root containment is lexical and can be bypassed through symlinks/junctions.** `resolvePath` checks `path.relative(projectRoot, resolved)` without resolving symlinks. If the project contains a symlink/junction such as `out -> C:\Users\...` or `out -> /etc`, Code Mode and plugin fs operations can pass a relative path like `out/secret.txt`; the lexical check sees it under the project root while filesystem operations follow the link outside the root. This undermines Code Mode's documented project containment. Fix: use `fs.realpath` on the root and target (or nearest existing parent for new files) before allowing reads/writes, and reject paths whose real target escapes. Related code: `src/main/services/projectContext.js:155-193`, `src/main/services/pluginManager.js:316-320`, `src/main/services/previewService.js:23-27`.

### `src/main/services/projectDetector.js`

**Bugs / notes:**

- TBD

### `src/main/services/worktreeManager.js`

**Bugs / notes:**

- TBD

## Batch 7 — Renderer

### `src/renderer/app.js`

**Bugs / notes:**

- TBD

### `src/renderer/effects/bgEffect.js`

**Bugs / notes:**

- TBD

### `src/renderer/entry.js`

**Bugs / notes:**

- TBD

### `src/renderer/modes/agentTools.js`

**Bugs / notes:**

- TBD

### `src/renderer/modes/chatLoop.js`

**Bugs / notes:**

- TBD

### `src/renderer/modes/code.js`

**Bugs / notes:**

- TBD

### `src/renderer/modes/modeHistory.js`

**Bugs / notes:**

- TBD

### `src/renderer/modes/runState.js`

**Bugs / notes:**

- TBD

### `src/renderer/styles/base.css`

**Bugs / notes:**

- TBD

### `src/renderer/styles/fonts.css`

**Bugs / notes:**

- TBD

### `src/renderer/styles/overlay.css`

**Bugs / notes:**

- TBD

### `src/renderer/timeline/activityTimeline.js`

**Bugs / notes:**

- TBD

### `src/renderer/timeline/diffView.js`

**Bugs / notes:**

- TBD

### `src/renderer/timeline/eventAdapter.js`

**Bugs / notes:**

- TBD

### `src/renderer/ui/codePlanPanel.js`

**Bugs / notes:**

- TBD

### `src/renderer/ui/codeRunUI.js`

**Bugs / notes:**

- TBD

### `src/renderer/ui/contextLabel.js`

**Bugs / notes:**

- TBD

### `src/renderer/ui/historyPersistence.js`

**Bugs / notes:**

- TBD

### `src/renderer/ui/modeBar.js`

**Bugs / notes:**

- TBD

### `src/renderer/ui/modelPicker.js`

**Bugs / notes:**

- TBD

### `src/renderer/ui/previewPanel.js`

**Bugs / notes:**

- TBD

### `src/renderer/ui/runtimeProfileUI.js`

**Bugs / notes:**

- TBD

### `src/renderer/ui/scrollFollow.js`

**Bugs / notes:**

- TBD

### `src/renderer/ui/sidebarLayout.js`

**Bugs / notes:**

- TBD

## Batch 8 — Shared/security-relevant utilities

### `src/shared/channelPolicy.js`

**Bugs / notes:**

- TBD

### `src/shared/chatSummarizer.js`

**Bugs / notes:**

- TBD

### `src/shared/commandPolicy.js`

**Bugs / notes:**

- TBD

### `src/shared/contextPrune.js`

**Bugs / notes:**

- TBD

### `src/shared/editFormats.js`

**Bugs / notes:**

- TBD

### `src/shared/gitIntegration.js`

**Bugs / notes:**

- TBD

### `src/shared/globTool.js`

**Bugs / notes:**

- TBD

### `src/shared/grepTool.js`

**Bugs / notes:**

- TBD

### `src/shared/ignoreFilter.js`

**Bugs / notes:**

- TBD

### `src/shared/ipcChannels.js`

**Bugs / notes:**

- TBD

### `src/shared/modelClassifier.js`

**Bugs / notes:**

- TBD

### `src/shared/netGuard.js`

**Bugs / notes:**

- TBD

### `src/shared/pathPolicy.js`

**Bugs / notes:**

- TBD

### `src/shared/planTemplates.js`

**Bugs / notes:**

- TBD

### `src/shared/renderThrottle.js`

**Bugs / notes:**

- TBD

### `src/shared/repoMap.js`

**Bugs / notes:**

- TBD

### `src/shared/runtimeProfile.js`

**Bugs / notes:**

- TBD

### `src/shared/smithPersona.js`

**Bugs / notes:**

- TBD

### `src/shared/verificationHarness.js`

**Bugs / notes:**

- TBD

## Batch 9 — Scripts / harnesses

### `scripts/agent-assistant-100-e2e.js`

**Bugs / notes:**

- TBD

### `scripts/agent-assistant-parity-e2e.js`

**Bugs / notes:**

- TBD

### `scripts/agent-e2e.js`

**Bugs / notes:**

- TBD

### `scripts/agent-hard-e2e.js`

**Bugs / notes:**

- TBD

### `scripts/agent-inapp-e2e.js`

**Bugs / notes:**

- TBD

### `scripts/agent-live-e2e.js`

**Bugs / notes:**

- TBD

### `scripts/agent-memory-recall-e2e.js`

**Bugs / notes:**

- TBD

### `scripts/bootstrap.mjs`

**Bugs / notes:**

- TBD

### `scripts/build-renderer.js`

**Bugs / notes:**

- TBD

### `scripts/check-native.js`

**Bugs / notes:**

- TBD

### `scripts/code-mode-100-e2e.js`

**Bugs / notes:**

- TBD

### `scripts/code-smoke.js`

**Bugs / notes:**

- TBD

### `scripts/create_icon.py`

**Bugs / notes:**

- TBD

### `scripts/ghosttrace-cli.js`

**Bugs / notes:**

- TBD

### `scripts/greenfield-smoke.js`

**Bugs / notes:**

- TBD

### `scripts/install-linux-desktop.sh`

**Bugs / notes:**

- TBD

### `scripts/print-download-link.js`

**Bugs / notes:**

- TBD

### `scripts/readiness-report.js`

**Bugs / notes:**

- TBD

### `scripts/ship-check.js`

**Bugs / notes:**

- TBD

### `scripts/standalone-server.js`

**Bugs / notes:**

- TBD

### `scripts/verify-main-ipc.js`

**Bugs / notes:**

- TBD

## Batch 10 — Examples / plugins / ghosttrace

### `examples/agentsmith-rules/no-console-in-src.js`

**Bugs / notes:**

- TBD

### `examples/pacman/index.html`

**Bugs / notes:**

- TBD

### `examples/pacman/script.js`

**Bugs / notes:**

- TBD

### `examples/pacman/style.css`

**Bugs / notes:**

- TBD

### `src/examples/plugins/hello/commands/greet.js`

**Bugs / notes:**

- TBD

### `src/examples/plugins/hello/hooks/audit.js`

**Bugs / notes:**

- TBD

### `src/examples/plugins/hello/plugin.json`

**Bugs / notes:**

- TBD

### `src/examples/plugins/hello/tools/echo.js`

**Bugs / notes:**

- TBD

### `src/ghosttrace/index.js`

**Bugs / notes:**

- TBD

## Batch 11 — Tests, part 1

### `tests/actionLog.test.js`

**Bugs / notes:**

- TBD

### `tests/activityTimeline.test.js`

**Bugs / notes:**

- TBD

### `tests/agentListDir.test.js`

**Bugs / notes:**

- TBD

### `tests/agentTools.test.js`

**Bugs / notes:**

- TBD

### `tests/artifactHints.test.js`

**Bugs / notes:**

- TBD

### `tests/artifactHintsNudge.test.js`

**Bugs / notes:**

- TBD

### `tests/auditContinuation.test.js`

**Bugs / notes:**

- TBD

### `tests/auditFixes.test.js`

**Bugs / notes:**

- TBD

### `tests/auth.test.js`

**Bugs / notes:**

- TBD

### `tests/autonomousGameBuild.test.js`

**Bugs / notes:**

- TBD

### `tests/beforeDone.test.js`

**Bugs / notes:**

- TBD

### `tests/codeMode.test.js`

**Bugs / notes:**

- TBD

### `tests/codeModeGeneral.test.js`

**Bugs / notes:**

- TBD

### `tests/codeModeReasoning.test.js`

**Bugs / notes:**

- TBD

### `tests/codePhases.test.js`

**Bugs / notes:**

- TBD

### `tests/codePlan.test.js`

**Bugs / notes:**

- TBD

### `tests/codePlanPanel.test.js`

**Bugs / notes:**

- TBD

### `tests/codeToolRegistry.test.js`

**Bugs / notes:**

- TBD

### `tests/codingTier2.test.js`

**Bugs / notes:**

- TBD

### `tests/contextPrune.test.js`

**Bugs / notes:**

- TBD

### `tests/coverageEngine.test.js`

**Bugs / notes:**

- TBD

### `tests/coverageSharedLogic.test.js`

**Bugs / notes:**

- TBD

### `tests/durable-modules.test.js`

**Bugs / notes:**

- TBD

### `tests/earlyStopNoProgress.test.js`

**Bugs / notes:**

- TBD

### `tests/editDeathSpiral.test.js`

**Bugs / notes:**

- TBD

### `tests/finalSummary.test.js`

**Bugs / notes:**

- TBD

### `tests/gemmaHarness.test.js`

**Bugs / notes:**

- TBD

### `tests/gitIntegration.test.js`

**Bugs / notes:**

- TBD

### `tests/harness-eval/capability/scenarios.test.js`

**Bugs / notes:**

- TBD

### `tests/harness-eval/regression/scenarios.test.js`

**Bugs / notes:**

- TBD

### `tests/harness-security/security.test.js`

**Bugs / notes:**

- TBD

### `tests/harnessExitPaths.test.js`

**Bugs / notes:**

- TBD

### `tests/harnessScaffold.test.js`

**Bugs / notes:**

- TBD

## Batch 12 — Tests, part 2

### `tests/historyPersistence.test.js`

**Bugs / notes:**

- TBD

### `tests/ipcHandlers.test.js`

**Bugs / notes:**

- TBD

### `tests/ipcResilience.test.js`

**Bugs / notes:**

- TBD

### `tests/jsonRepair.test.js`

**Bugs / notes:**

- TBD

### `tests/lenientExtract.test.js`

**Bugs / notes:**

- TBD

### `tests/lmStudioIpc.test.js`

**Bugs / notes:**

- TBD

### `tests/lmStudioManager.test.js`

**Bugs / notes:**

- TBD

### `tests/memoryCodeMode.test.js`

**Bugs / notes:**

- TBD

### `tests/memoryEmbedding.test.js`

**Bugs / notes:**

- TBD

### `tests/milestoneSubagents.test.js`

**Bugs / notes:**

- TBD

### `tests/missingRefGuard.test.js`

**Bugs / notes:**

- TBD

### `tests/modeBar.test.js`

**Bugs / notes:**

- TBD

### `tests/modeHistory.test.js`

**Bugs / notes:**

- TBD

### `tests/modelClassifier.test.js`

**Bugs / notes:**

- TBD

### `tests/multiFileDrive.test.js`

**Bugs / notes:**

- TBD

### `tests/pacmanRegression.test.js`

**Bugs / notes:**

- TBD

### `tests/pathPolicy.test.js`

**Bugs / notes:**

- TBD

### `tests/perfFreeze.test.js`

**Bugs / notes:**

- TBD

### `tests/phaseCompact.test.js`

**Bugs / notes:**

- TBD

### `tests/planArtifacts.test.js`

**Bugs / notes:**

- TBD

### `tests/planningPhase.test.js`

**Bugs / notes:**

- TBD

### `tests/pluginCodeMode.test.js`

**Bugs / notes:**

- TBD

### `tests/pluginIntegrity.test.js`

**Bugs / notes:**

- TBD

### `tests/pluginSandbox.test.js`

**Bugs / notes:**

- TBD

### `tests/pluginSystem.test.js`

**Bugs / notes:**

- TBD

### `tests/postEditChecks.test.js`

**Bugs / notes:**

- TBD

### `tests/previewPath.test.js`

**Bugs / notes:**

- TBD

### `tests/projectDetector.test.js`

**Bugs / notes:**

- TBD

### `tests/projectRoot.test.js`

**Bugs / notes:**

- TBD

### `tests/projectRules.test.js`

**Bugs / notes:**

- TBD

### `tests/reasoningStrip.test.js`

**Bugs / notes:**

- TBD

### `tests/rendererLoadOrder.test.js`

**Bugs / notes:**

- TBD

### `tests/runWatchdog.test.js`

**Bugs / notes:**

- TBD

### `tests/runtimeProfile.test.js`

**Bugs / notes:**

- TBD

### `tests/runtimeProfileUI.test.js`

**Bugs / notes:**

- TBD

### `tests/scrollFollow.test.js`

**Bugs / notes:**

- TBD

### `tests/securityPolicy.test.js`

**Bugs / notes:**

- TBD

### `tests/smithPersona.test.js`

**Bugs / notes:**

- TBD

### `tests/sseHub.test.js`

**Bugs / notes:**

- TBD

### `tests/subdirRefs.test.js`

**Bugs / notes:**

- TBD

### `tests/symbolMap.test.js`

**Bugs / notes:**

- TBD

### `tests/truncation.test.js`

**Bugs / notes:**

- TBD

### `tests/webValidators.test.js`

**Bugs / notes:**

- TBD

### `tests/whatsappChrome.test.js`

**Bugs / notes:**

- TBD

### `tests/whatsappOptional.test.js`

**Bugs / notes:**

- TBD

### `tests/xmlToolCalls.test.js`

**Bugs / notes:**

- TBD
