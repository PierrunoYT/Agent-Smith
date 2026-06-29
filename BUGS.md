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

- **FIXED in `fix-batch-1` (`f3acbd3`) — LOW — duplicate renderer console logging.** `mainWindow.webContents.on("console-message", ...)` was registered twice in a row, so every renderer console message was logged twice. Fixed by removing one duplicate listener. Related code: `main.js:394-395`.
- **FIXED in `fix-batch-1` (`f3acbd3`) — MEDIUM — unbounded `/api/invoke` request body accumulation.** The mobile/web IPC proxy concatenated request chunks into `body` with no maximum size before `JSON.parse`. Fixed by enforcing a 1 MB request body cap and returning `413 Payload Too Large` once exceeded. Related code: `main.js:872-879`.
- **FIXED in `fix-batch-1` (`f3acbd3`) — MEDIUM — unauthenticated static source disclosure for any `.js` / `.css` / image path.** The auth gate treated any URL ending in `.js`, `.css`, `.png`, or `.jpg` as public, then static serving allowed any contained path under the app directory. Fixed by replacing extension wildcarding with an explicit public asset allowlist. Related code: `main.js:787-803`, `main.js:962-986`.
- **FIXED in `fix-batch-1` (`f3acbd3`) — MEDIUM — auto-download and execute moving `cloudflared` binary without integrity verification.** Startup downloaded `cloudflared` from GitHub `latest` release URLs and later spawned the downloaded binary by default. Fixed by making tunnel startup and first download explicitly opt-in via environment flags. Related code: `main.js:1006-1033`.

### `preload.js`

**Bugs / notes:**

- TBD

### `replace-tools.js`

**Bugs / notes:**

- **FIXED in `fix-batch-1` (`f3acbd3`) — LOW — obsolete/missing legacy-path migration helper appears to fail by default.** The script read `hotfix2/v41.7/tools.js` and `hotfix2/v41.7/index.js` unconditionally; if those legacy files were not present, it threw before doing anything. Fixed by accepting explicit legacy paths and reporting a clear usage error when required files are missing. Related code: `replace-tools.js:3-16`.

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

- **FIXED in `fix-batch-2` (`a77af66`) — LOW — phase compaction can drop tool results from multi-tool assistant turns.** `collectRecentToolPairs` only preserves a `tool` message when the immediately previous message is an `assistant` with `tool_calls`. For an assistant turn that emits multiple tool calls followed by multiple `tool` messages, only the first adjacent pair is kept and later tool results are skipped during compaction. Fixed by grouping all consecutive `tool` messages following each assistant `tool_calls` message and preserving the last grouped turns. Related code: `src/code/context/phaseCompact.js:15-27`.

### `src/code/context/planAnchor.js`

**Bugs / notes:**

- TBD

### `src/code/context/planArtifacts.js`

**Bugs / notes:**

- **FIXED in `fix-batch-2` (`a77af66`) — MEDIUM — default Final milestone is not parsed as a milestone with verify command.** `defaultPlanContent` writes `- [ ] **Final: all checks pass** — verify: \`harness completion gate\`` without the `| verify:` separator required by `MILESTONE_RE`. Because M1/M2 do match the strict regex, `reloadMilestones` never falls back to `MILESTONE_SIMPLE`, so the Final milestone is omitted entirely from `this.milestones`. Fixed by making the default Final line use `| verify:` and loosening the milestone regexes to accept both `|` and em-dash separators. Related code: `src/code/context/planArtifacts.js:15-18`, `src/code/context/planArtifacts.js:61-63`, `src/code/context/planArtifacts.js:168-194`.

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

- **FIXED in `fix-batch-3` (`fbcbb81`) — MEDIUM — game acceptance can count score initialization as a score update.** `scoreMutated` matches any assignment to `score`, including initial declarations like `let score = 0`, and `scoreShown` passes if an HTML element id contains `score`. A static game with a score element and initial score assignment can pass the `score updates` acceptance check without ever changing or re-rendering score during gameplay. Fixed by requiring runtime score mutation and a DOM score render that references the score value. Related code: `src/code/governor/acceptance.js:53-60`.

### `src/code/governor/completionGate.js`

**Bugs / notes:**

- **FIXED in `fix-batch-3` (`fbcbb81`) — MEDIUM — web validation follows HTML script/style references outside the project root.** `runValidation` resolves each non-HTTP HTML `script`/`link` reference with `path.resolve(htmlDir, ref)` and later reads those resolved files into `combinedCss` / `combinedJs` if they exist, without checking that the resolved path remains inside `projectRoot`. A generated `index.html` containing `../` references could make Code Mode validation read files outside the workspace, conflicting with Code Mode's project-root containment model. Fixed by rejecting refs whose resolved absolute path is outside `projectRoot` before reading them. Related code: `src/code/governor/completionGate.js:188-217`.

### `src/code/governor/earlyStop.js`

**Bugs / notes:**

- TBD

### `src/code/governor/postEditChecks.js`

**Bugs / notes:**

- TBD

### `src/code/governor/projectRules.js`

**Bugs / notes:**

- **FIXED in `fix-batch-3` (`fbcbb81`) — MEDIUM — project-local rule loading executes arbitrary `.agentsmith/rules/*.js` during Code Mode validation.** `loadRules` walks `.agentsmith/rules` and calls `require(abs)` for every `.js` rule file with no signing, prompt, sandbox, or repository trust check. Because Code Mode auto-runs validation, opening/running an untrusted project can execute project-provided JavaScript in the main process. Fixed by disabling project-local JS rules by default and requiring explicit opt-in via `projectRulesEnabled` or `AGENT_SMITH_ENABLE_PROJECT_RULES=1`. Related code: `src/code/governor/projectRules.js:15-49`.

### `src/code/governor/qualityMonitor.js`

**Bugs / notes:**

- TBD

### `src/code/governor/readiness.js`

**Bugs / notes:**

- TBD

### `src/code/governor/smokeTest.js`

**Bugs / notes:**

- **FIXED in `fix-batch-3` (`fbcbb81`) — MEDIUM — smoke test follows local script references outside the project root.** `readLocalScripts` resolves every non-HTTP `<script src>` with `path.resolve(htmlDir, rel)` and reads it without verifying that the resolved path stays under `projectRoot`. A generated HTML file with `../` references can make the smoke test read and execute JavaScript outside the workspace in the VM/jsdom smoke environment, violating Code Mode's project-root containment expectation. Fixed by rejecting external-to-root resolved script paths before reading/executing them. Related code: `src/code/governor/smokeTest.js:25-43`, `src/code/governor/smokeTest.js:181-187`, `src/code/governor/smokeTest.js:211-224`.
- **FIXED in `fix-batch-3` (`fbcbb81`) — LOW — smoke-test DOM stub masks real missing-element errors.** The VM fallback returns a stub element for any `getElementById` / `querySelector` call, even when the element does not exist in the HTML. This avoids false positives, but it can also hide real bugs where app code expects missing DOM nodes and would throw in a browser. Fixed by running a strict DOM consistency pass after the permissive VM smoke pass. Related code: `src/code/governor/smokeTest.js:88-92`, `src/code/governor/smokeTest.js:128-138`.

### `src/code/governor/webValidators.js`

**Bugs / notes:**

- **FIXED in `fix-batch-3` (`fbcbb81`) — LOW — serialization-artifact detector flags legitimate escaped braces in JavaScript strings/regex.** `detectSerializationArtifacts` treats any `\\{` or `\\}` in a text file as corruption. That pattern can be valid JavaScript, especially regex literals or string patterns that intentionally escape literal braces. Because completion validation runs this detector over JS/CSS/HTML, valid code can be blocked as a leaked JSON artifact. Fixed by blanking strings, template literals, comments, and regex literals before structural escaped-brace detection, with regression coverage. Related code: `src/code/governor/webValidators.js:455-467`.

## Batch 4 — Code Mode: loop / tools

### `src/code/loop/codeTrace.js`

**Bugs / notes:**

- **FIXED in `fix-batch-4` (`247b663`) — LOW — `query_run_trace` returns empty/undefined failure metadata because it reads the wrong step fields.** `PipelineTrace.addStep()` stores `outcome`, `duration_ms`, and `related_resource`, but `CodeRunTrace.query()` filters/counts on `s.status` and maps `s.tool`/`s.ms`. The exposed `query_run_trace` tool therefore reports `summary.failures: 0` for failed trace steps and returns steps without status/tool/timing, making verify-phase diagnostics misleading. Fixed by normalizing `outcome`, `related_resource`, and `duration_ms` to query fields before filtering/counting. Related code: `src/ghosttrace/index.js:72-91`, `src/code/loop/codeTrace.js:75-104`, `src/code/tools/executor.js:151-159`, `tests/codeToolRegistry.test.js:22-37`.

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

- **FIXED in `fix-batch-4` (`247b663`) — MEDIUM — concurrent milestone worktrees share mutable orchestrator objects.** In `worktree-concurrent` mode, `Promise.all` runs multiple `runOneMilestone` calls with the same `planAnchor`, `planArtifacts`, `earlyStop`, `qualityMonitor`, `trace`, `execDeps`, and `projectContext`. Each child turn loop can append plan artifacts, update shared counters/trace, and temporarily call `projectContext.setRoot(worktreePath)`. Concurrent root switching and shared state mutation can race, causing tools to run against the wrong worktree or corrupt parent run state. Fixed by disabling true worktree concurrency and resolving milestone worktrees to sequential mode until dependencies are isolated per worktree. Related code: `src/code/loop/milestoneSubagents.js:71-120`, `src/code/loop/milestoneSubagents.js:165-167`.
- **FIXED in `fix-batch-4` (`247b663`) — LOW — worktree cleanup is skipped when a child turn loop throws.** `cleanupMilestoneWorktree` runs only after `executeTurnLoop` completes successfully and after syncing files. If `executeTurnLoop` throws, the `finally` restores `projectContext` but does not cleanup the created worktree, leaving temporary branches/worktrees behind. Fixed by moving cleanup into the `finally` path guarded by `useWorktree && worktreePath`, while preserving sync after successful child runs. Related code: `src/code/loop/milestoneSubagents.js:95-130`.

### `src/code/loop/missingRefGuard.js`

**Bugs / notes:**

- TBD

### `src/code/loop/phases.js`

**Bugs / notes:**

- TBD

### `src/code/loop/planningPhase.js`

**Bugs / notes:**

- **FIXED in `fix-batch-4` (`247b663`) — MEDIUM — planning mode can execute write/shell tool calls before user approval.** The planning loop offers only read tools plus `submit_code_plan`, but it executes every non-`submit_code_plan` call returned in `msg.tool_calls` directly through `executeTool` with the full executor dependencies and no phase gate or explicit allowlist. If a model/server returns a native `write_file`, `patch`, `append_file`, or `run_command` call despite the advertised tool list, planning mode can mutate the project or run shell commands before a plan is submitted/approved. Fixed by enforcing an explicit planning allowlist before `executeTool`. Related code: `src/code/loop/planningPhase.js:29-35`, `src/code/loop/planningPhase.js:84-98`.

### `src/code/loop/reasoningStrip.js`

**Bugs / notes:**

- TBD

### `src/code/loop/runCodeTask.js`

**Bugs / notes:**

- **FIXED in `fix-batch-4` (`247b663`) — MEDIUM — isolated Code runs leave the global project root switched to the worktree and skip normal cleanup.** Whole-run isolation creates a git worktree, rewrites `session.projectRoot`, and calls `projectContext.setRoot(wt.path)`, but the normal `executeTurnLoop` path never restores `projectContext` to `parentProjectRoot`. Its cleanup guard also requires `opts.projectRoot`, yet the final `executeTurnLoop({ ... })` call does not pass `projectRoot`, so `cleanupWorktree(...)` is skipped after non-subagent isolated runs. A completed isolated run can therefore leave subsequent app operations pointed at `.agentsmith/worktrees/<session>` instead of the original checkout, with temporary worktrees/branches accumulating. Fixed by passing the parent project root into `executeTurnLoop`, restoring `projectContext`, and cleaning isolated run worktrees in `finally`. Related code: `src/code/loop/runCodeTask.js:98-100`, `src/code/loop/runCodeTask.js:246-258`, `src/code/loop/runCodeTask.js:407-425`.

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

- **FIXED in `fix-batch-4` (`247b663`) — LOW — malformed `write_file` without content can throw after recording ledger state.** The `write_file` branch validates `path` and calls `checkWriteChunkSize(a.content)`, but it never requires `content` to be a string before taking a change-ledger snapshot/recordCreate and passing `a.content` to `fs.writeFile`. If a model emits `write_file` with a path but missing `content`, `fs.writeFile(..., undefined, 'utf-8')` throws instead of returning a normal tool error, potentially after `recordCreate` has logged a create for a file that was never written. Fixed by rejecting missing/non-string content before any ledger operation. Related code: `src/code/tools/executor.js:214-237`.

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

- **FIXED in `fix-batch-5` (`9eabe73`) — LOW — `actions-clear` can erase the Agent Mode audit trail without a scoped confirmation or undo.** The action log is the documented trust layer for Agent Mode, but the IPC handler exposes `actions-clear` as a one-shot call to `log.clear()`, which irreversibly removes every recorded action and its undo metadata. The web permission policy gates `actions-*` behind tool permission, but there is no per-call confirmation, session scoping, or preservation of reversible entries. Fixed by soft-archiving cleared entries while preserving undo data addressable by id. Related code: `src/main/ipc/actions.js:12-14`, `src/main/services/actionLog.js:84`.

### `src/main/ipc/agent.js`

**Bugs / notes:**

- **FIXED in `fix-batch-5` (`9eabe73`) — MEDIUM — Agent Mode directory deletes are marked reversible but only recreate an empty directory.** `agent-delete-file` logs an undo object for directories as `{ op:'delete', isDir:true }` after recursively deleting the directory with `fs.rm(..., { recursive:true, force:true })`. `actionLog.undo` handles that by only calling `fs.mkdirSync(u.path, { recursive:true })`, so `undo_action` reports success while all deleted child files remain lost. Fixed by logging directory deletes as audit-only/non-reversible rather than falsely reversible. Related code: `src/main/ipc/agent.js:282-305`, `src/main/services/actionLog.js:70-72`.

### `src/main/ipc/auth.js`

**Bugs / notes:**

- TBD

### `src/main/ipc/code.js`

**Bugs / notes:**

- **FIXED in `fix-batch-5` (`9eabe73`) — LOW — background Code Mode command spawn failures can crash the main process.** Agent Mode background commands attach a child `error` handler, but Code Mode's equivalent `runBackgroundCommand` does not. If `spawnShell` fails asynchronously (missing shell, invalid cwd, OS error), the unhandled child `error` event can terminate the Electron main process instead of returning/logging a tool failure. Fixed by attaching a child `error` handler and recording failed-job metadata. Related code: `src/main/ipc/code.js:105-120`; contrast `src/main/ipc/agent.js:138-144`.
- **FIXED in `fix-batch-5` (`9eabe73`) — MEDIUM — Code Mode IPC drops isolation and milestone flags before starting runs.** The `code-run` handler reads `isolatedRun`, `parallelMilestones`, `milestoneWorktrees`, and `milestoneConcurrent` from renderer options and passes them into `startCodeTask`, but `startCodeTask` does not copy any of those flags into the `base` object sent to `runCodeTask`. As a result, toggling isolated runs or parallel/milestone worktrees in the UI has no effect on the main execution path; worktree isolation and subagent orchestration can silently stay disabled. Fixed by propagating and preserving these booleans through `startCodeTask`. Related code: `src/main/ipc/code.js:149-176`, `src/main/ipc/code.js:213-228`, `src/code/loop/runCodeTask.js:240-258`, `src/code/loop/runCodeTask.js:350-372`.

### `src/main/ipc/edit.js`

**Bugs / notes:**

- **FIXED in `fix-batch-5` (`9eabe73`) — LOW — patch/batch edit IPC handlers crash when `planStore` is absent.** `main.js` does not inject `planStore` into `registerAllIpc`, and `edit-apply` correctly treats it as optional, but `edit-apply-patch` calls `planStore.load(pid)` unconditionally on success and `edit-apply-batch` calls `planStore.load(pid)` inside a try that still dereferences `undefined`. Invoking those whitelisted channels with a valid plan id can therefore throw instead of returning a structured result. Fixed by guarding patch/batch plan-store updates when `planStore` is unavailable. Related code: `src/main/ipc/edit.js:37-68`, `main.js:697-719`, `tests/ipcHandlers.test.js:51-70`.

### `src/main/ipc/git.js`

**Bugs / notes:**

- **FIXED in `fix-batch-5` (`9eabe73`) — MEDIUM — `git-undo` can hard-reset unrelated user commits without confirmation or ownership checks.** The IPC handler exposes `git-undo` as a direct call to `gitIntegration.undoLast(projectContext.getRoot())`. The underlying implementation runs `git reset --hard HEAD~1` when a parent commit exists, with no check that the last commit was created by Agent Smith and no dirty-worktree guard. A tool-capable web/renderer caller can therefore discard the user's latest commit and uncommitted working tree changes, not just an Agent Smith checkpoint. Fixed by recording Agent Smith-owned commits and refusing undo when `HEAD` is unowned or the worktree is dirty. Related code: `src/main/ipc/git.js:23`, `src/shared/gitIntegration.js:47-55`.

### `src/main/ipc/history.js`

**Bugs / notes:**

- TBD

### `src/main/ipc/index.js`

**Bugs / notes:**

- TBD

### `src/main/ipc/ledger.js`

**Bugs / notes:**

- **FIXED in `fix-batch-5` (`9eabe73`) — LOW — ledger IPC can throw when no plan/session id is available.** Both `ledger-diff` and `ledger-revert-all` fall back to `state.currentPlanId` when no explicit id is passed, then call `changeLedger.diff/revertAll` unconditionally. If there is no active plan/session, `state.currentPlanId` can be `null`/`undefined`; `ChangeLedger.getLedgerDir(planId)` then passes that value to `path.join`, which throws instead of returning a structured `{ error: 'No active plan' }`. Fixed by validating the resolved plan id before calling the ledger. Related code: `src/main/ipc/ledger.js:11-13`, `src/main/services/changeLedger.js:11-13`, `src/main/services/changeLedger.js:146-188`.

### `src/main/ipc/lmStudio.js`

**Bugs / notes:**

- TBD

### `src/main/ipc/memory.js`

**Bugs / notes:**

- **FIXED in `fix-batch-5` (`9eabe73`) — MEDIUM — memory write/delete IPC is not gated by tool permission.** The shared web permission policy gates `agent-`, `code-`, `git-`, `edit-`, `plugin-`, `ledger-`, `preview-`, and `actions-` channels, but not `mem-*`. As a result, any authenticated web user with `canUseApp` can call `mem-store` to persist arbitrary text into cross-session memory and `mem-clear` to erase all vector memory, even when `canUseTools` is false. The tests only assert `mem-query` is read-only; the mutating memory channels are not distinguished. Fixed by adding `mem-store` and `mem-clear` to tool-permission gated channels while leaving read-only memory query/count ungated. Related code: `src/main/ipc/memory.js:9-23`, `src/shared/channelPolicy.js:13-28`, `tests/securityPolicy.test.js:102-110`.

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

- **FIXED in `fix-batch-5` (`9eabe73`) — MEDIUM — WhatsApp send IPC bypasses tool-permission gating.** `whatsapp-send` has a real-world side effect (sending a message) and is exposed as the Agent Mode `send_whatsapp_message` tool, but `whatsapp-*` channels are not included in `TOOL_PREFIXES` or `TOOL_CHANNELS`. Through `/api/invoke`, any authenticated user whose account can use the app can call `whatsapp-send` once WhatsApp is linked, even if `canUseTools` is false. Fixed by gating `whatsapp-*` channels behind tool permission. Related code: `src/main/lifecycle/whatsapp.js:134-139`, `src/renderer/modes/agentTools.js:449-451`, `src/shared/channelPolicy.js:13-28`.
- **FIXED in `fix-batch-5` (`9eabe73`) — LOW — failed WhatsApp initialization leaves a stale client object that blocks retry.** `whatsapp-init` assigns `whatsappClient = new Client(...)` before `await whatsappClient.initialize()`. If initialization throws, the catch returns `{ error }` but does not destroy the client or reset `whatsappClient` to `null`. Subsequent `whatsapp-init` calls hit the early `if (whatsappClient) return { status:'already_init' }` path even though the client is not ready, and the failed headless browser/session may remain alive until cancellation or process exit. Fixed by destroying and clearing partially-created clients on initialization failure. Related code: `src/main/lifecycle/whatsapp.js:69-83`, `src/main/lifecycle/whatsapp.js:116-121`.

### `src/main/server/previewRoutes.js`

**Bugs / notes:**

- TBD

### `src/main/server/pushEvent.js`

**Bugs / notes:**

- TBD

### `src/main/server/sseHub.js`

**Bugs / notes:**

- **FIXED in `fix-batch-5` (`9eabe73`) — LOW — SSE broadcast ignores backpressure from slow clients.** `broadcast` writes every event frame to every connected `ServerResponse` and only removes clients when `write()` throws. If a web/mobile client stops reading but keeps the TCP connection open, `res.write(frame)` can return `false` and Node will buffer subsequent frames in memory indefinitely. Frequent `code-event`/resource updates could therefore let a slow client cause avoidable memory growth. Fixed by dropping/ending clients when `write()` reports backpressure. Related code: `src/main/server/sseHub.js:35-50`, `tests/sseHub.test.js:25-33`.

## Batch 6 — Main process services

### `src/main/services/actionLog.js`

**Bugs / notes:**

- **FIXED in `fix-batch-6` (`1a6e751`) — LOW — action log reports success even when persistence fails.** The action log is documented as durable audit/undo storage, but `save()` swallows every `fs.writeFileSync` error and `record()` still returns a fresh id. If the userData directory is non-writable, full, or otherwise failing, Agent Mode can perform consequential actions while the audit trail and undo metadata exist only in memory and disappear on restart, with no warning to the caller/user. Fixed by surfacing persistence failures from `save()`/`record()`/`clear()` so the trust layer does not silently degrade to in-memory-only. Related code: `src/main/services/actionLog.js:30`, `src/main/services/actionLog.js:34-48`.

### `src/main/services/auth.js`

**Bugs / notes:**

- TBD

### `src/main/services/browserVerify.js`

**Bugs / notes:**

- **FIXED in `fix-batch-6` (`1a6e751`) — MEDIUM — model-supplied browser verification checks can hang indefinitely.** `browser_verify` accepts arbitrary JavaScript expressions from the model and executes each one with `webContents.executeJavaScript(...)`, but only the page load has a timeout. A check such as `while(true){}` or a never-resolving promise can leave `run()` awaiting forever, preventing the `finally` block from destroying the hidden BrowserWindow and stalling the Code Mode run. Fixed by wrapping each model-supplied check in a 5s timeout race and destroying the hidden `BrowserWindow` on timeout. Related code: `src/main/services/browserVerify.js:59-70`, `src/main/services/browserVerify.js:74-94`, `src/code/tools/schemas.js:147-158`.

### `src/main/services/changeLedger.js`

**Bugs / notes:**

- **FIXED in `fix-batch-6` (`1a6e751`) — MEDIUM — snapshot failures can turn existing-file edits into destructive revert deletes.** `snapshotBefore` wraps access, file read, and snapshot write in one broad `try/catch`; any failure sets `existed=false` and still records a manifest entry. If the target file exists but reading it or writing the snapshot fails (permissions, EISDIR, disk full, transient IO), the later edit/delete can proceed while `revertAll` treats the path as newly created and unlinks it instead of restoring original content. Directory deletes hit this path because `readFile(directory)` throws, so the ledger cannot restore them but records them as non-existing. Fixed by distinguishing "snapshot failed" from "did not exist", aborting the mutation on snapshot failure, and marking directory snapshots as audit-only rather than `existed:false`. Related code: `src/main/services/changeLedger.js:45-70`, `src/main/services/changeLedger.js:187-207`.
- **FIXED in `fix-batch-6` (`1a6e751`) — LOW — created directories are not reverted by Revert All.** `recordCreate` records only a path/action, and `revertAll` removes created entries with `fsPromises.unlink(entry.path)`. If a tool records creation of a directory, or a file creation also creates new parent directories, Revert All cannot remove the directory tree; `unlink` on a directory reports `EISDIR`, and parent directories created solely for the run are left behind. Fixed by recording entry type (`file`/`dir`) and removing created directories with `rm({recursive:true})`. Related code: `src/main/services/changeLedger.js:73-86`, `src/main/services/changeLedger.js:195-201`, `src/code/tools/executor.js:236-237`.

### `src/main/services/editEngine.js`

**Bugs / notes:**

- **FIXED in `fix-batch-6` (`1a6e751`) — LOW — `applyPatch` silently ignores all but the first file in a unified diff.** `applyPatchToFile` parses every file header in a patch but applies only `parsed[0]`, and `EditEngine.applyPatch` writes that result to the separately supplied `filePath`. A multi-file patch can therefore report success while dropping every later file hunk, and a patch whose first header names a different file can be applied to the caller's `filepath` anyway. Fixed by rejecting multi-file patches and verifying the parsed patch path matches the caller's `filePath`. Related code: `src/main/services/editEngine.js:110-144`, `src/shared/editFormats.js:165-174`.

### `src/main/services/lmStudioManager.js`

**Bugs / notes:**

- **FIXED in `fix-batch-6` (`1a6e751`) — MEDIUM — failed LM Studio context reload can unload the user's working model.** `ensureNow` first runs estimate-only probes, then unloads the currently loaded model, then attempts the real `lms load` for the selected context. If that final load fails (CLI error, transient LM Studio failure, model path issue), the error propagates to IPC after the previous loaded instance has already been unloaded, leaving the user with no working model and no rollback attempt. Fixed by attempting to restore the previously loaded context/parallel settings on real load failure so the user is not left with no working model. Related code: `src/main/services/lmStudioManager.js:178-193`, `src/main/ipc/lmStudio.js:21-30`.

### `src/main/services/memory.js`

**Bugs / notes:**

- **FIXED in `fix-batch-6` (`1a6e751`) — LOW — memory store/clear report success even when persistence fails.** `saveJSON` returns `false` on write errors, but `storeVector` ignores that return value and still returns `{ success:true }` after pushing the vector in memory; `clearMemory` likewise returns `true` regardless of whether the emptied database was written. If the userData directory is non-writable or full, the UI/model can believe memory was saved or wiped while the change is lost on restart. Fixed by propagating `saveJSON` failures from `storeVector`/`clearMemory` and surfacing a warning to callers instead of reporting success. Related code: `src/main/services/memory.js:125-136`, `src/main/services/memory.js:231-244`.

### `src/main/services/pluginHost.js`

**Bugs / notes:**

- TBD

### `src/main/services/pluginInstaller.js`

**Bugs / notes:**

- **FIXED in `fix-batch-6` (`1a6e751`) — HIGH — plugin installation can fetch unpinned, mutable code and execute it after a shallow clone.** `install(url)` accepts arbitrary public git/http URLs, clones the default branch with `git clone --depth 1`, validates only `plugin.json`, and then installs bytes that `pluginManager.discover()` can later `require()` in the main process. GitHub web URLs without `git` fall back to `refs/heads/main`/`master` tarballs. There is no commit SHA pinning, signature check, checksum prompt, or immutable source requirement, so a compromised upstream branch or TOCTOU update between review and install becomes trusted app code. Fixed by requiring immutable commit/tag refs (refusing mutable branch HEADs without an explicit `allowMutable` opt-in) so a compromised or TOCTOU-updated branch can no longer become trusted app code. Related code: `src/main/services/pluginInstaller.js:114-152`, `src/main/services/pluginManager.js:187-199`, `src/main/services/pluginManager.js:201-224`.
- **FIXED in `fix-batch-6` (`1a6e751`) — LOW — failed plugin downloads leave partial archive files open in staging.** `_httpsDownload` creates a write stream before making the request, but on HTTP errors, redirects beyond the limit, validation failures, or request errors it rejects without closing/destroying the stream or unlinking the partial destination. The outer `finally` removes the staging directory, but an open file descriptor can make cleanup fail on Windows and leave temp data behind. Fixed by destroying/closing the stream and unlinking partial files on every failure path before rejecting, so open descriptors no longer block Windows cleanup. Related code: `src/main/services/pluginInstaller.js:49-67`, `src/main/services/pluginInstaller.js:123-157`.

### `src/main/services/pluginIntegrity.js`

**Bugs / notes:**

- **FIXED in `fix-batch-6` (`1a6e751`) — MEDIUM — plugin integrity hashing ignores non-code assets that can affect runtime behavior.** `hashPluginDir` hashes only `.js`, `.cjs`, `.mjs`, and `.json` files, skipping everything else under the plugin directory. Trusted plugin code can read templates, prompts, binaries, WASM, certificates, or data files at runtime; changing those skipped files after trust-on-enable will not change the trusted hash and will not quarantine the plugin. Fixed by hashing every file under the plugin dir (not just `.js`/`.cjs`/`.mjs`/`.json`) so templates/binaries/WASM/data changes are detected and quarantine the plugin. Related code: `src/main/services/pluginIntegrity.js:16-29`, `src/main/services/pluginIntegrity.js:37-52`.
- **FIXED in `fix-batch-6` (`1a6e751`) — LOW — unreadable plugin files hash as empty content instead of failing closed.** During hashing, `readFileSync` errors are caught and replaced with an empty string. A transient permissions/IO error can therefore produce a deterministic hash that gets trusted in `setEnabled`, and later restoring file readability changes the bytes again; conversely a malicious local actor can make a file unreadable during re-enable to trust the wrong content set. Fixed by propagating read errors and failing closed (throwing) when any hash input cannot be read, refusing enable/discover trust decisions on unreadable files. Related code: `src/main/services/pluginIntegrity.js:44-49`, `src/main/services/pluginManager.js:451-456`.

### `src/main/services/pluginManager.js`

**Bugs / notes:**

- **FIXED in `fix-batch-6` (`1a6e751`) — HIGH — plugin command and hook execution bypasses the opt-in sandbox.** `invokeTool` can use `runToolSandboxed` when sandbox mode is enabled, but `runCommandText` and `fireHook` always build an in-process host and call plugin code directly. A plugin can put malicious code in a command or hook contribution and regain full main-process privileges even when the user/admin enabled `AGENT_SMITH_PLUGIN_SANDBOX=1`. Fixed by routing command and hook contributions through the same sandbox runner when sandbox mode is enabled. Related code: `src/main/services/pluginManager.js:346-375`, `src/main/services/pluginManager.js:403-436`, `src/main/services/pluginSandbox.js:32-84`.
- **FIXED in `fix-batch-6` (`1a6e751`) — MEDIUM — sandbox infrastructure failures silently fall back to trusted in-process execution.** In `invokeTool`, any sandbox error is logged and the tool is then executed in-process. That means a misconfigured Node permission model, unsupported Electron fork behavior, or malicious plugin that intentionally breaks sandbox startup turns a requested isolation policy into full main-process execution without surfacing failure to the user. Fixed by failing closed on sandbox infrastructure failure (no silent in-process fallback) when sandbox mode is enabled. Related code: `src/main/services/pluginManager.js:350-365`, `src/main/services/pluginManager.js:368-375`.
- **FIXED in `fix-batch-6` (`1a6e751`) — LOW — plugin state persistence failures are not converted to structured errors.** `setEnabled` and `uninstall` call `saveState()` directly; if the plugin state file cannot be written, the exception propagates through IPC/web as a generic 500 after in-memory enablement/deletion has already happened. The UI may show a failed request while the current process state changed and will revert on restart. Fixed by persisting state before mutating the live registry and rolling back on write failure, returning structured failures without partial state changes. Related code: `src/main/services/pluginManager.js:78-81`, `src/main/services/pluginManager.js:441-477`, `src/main/services/pluginManager.js:480-491`.

### `src/main/services/pluginSandbox.js`

**Bugs / notes:**

- TBD

### `src/main/services/pluginSandboxRunner.js`

**Bugs / notes:**

- **FIXED in `fix-batch-6` (`1a6e751`) — LOW — sandbox runner trusts the parent-supplied tool file without an in-child containment check.** `runToolSandboxed` currently passes contribution files discovered by `pluginManager`, which are already scoped to the plugin directory, but the exported runner protocol itself sends only `toolFile` and the child blindly `require(msg.toolFile)`. If future sandboxed command/hook support or a custom caller passes a file outside the plugin directory while also granting project-root fs permissions, the child has no second containment check. Fixed by sending `pluginDir` to the child and re-checking `toolFile` containment in `pluginSandboxRunner`, rejecting files outside the plugin dir before `require`. Related code: `src/main/services/pluginSandbox.js:32-42`, `src/main/services/pluginSandbox.js:79-80`, `src/main/services/pluginSandboxRunner.js:57-70`.

### `src/main/services/previewRunner.js`

**Bugs / notes:**

- **FIXED in `fix-batch-6` (`1a6e751`) — MEDIUM — pending desktop screenshot requests are not bound to the requesting preview.** `show({kind:'screenshot'})` stores a pending preview id for user source selection, but `captureSource` accepts any `sourceId` and will capture it even when `previewId` is missing or not found. A renderer/web caller with preview permission can skip the pick-source flow and request capture of any source id it has learned from `preview-list-sources`, bypassing the pending request/consent association. Fixed by binding desktop screenshot capture to a valid, non-expired pending `previewId` and denying stale or unknown ids so a renderer caller cannot bypass the pick-source consent flow. Related code: `src/main/services/previewRunner.js:121-130`, `src/main/services/previewRunner.js:137-164`, `src/main/ipc/preview.js:34-40`.

### `src/main/services/previewService.js`

**Bugs / notes:**

- **FIXED in `fix-batch-6` (`1a6e751`) — LOW — preview capture viewport is not bounded before creating BrowserWindow.** `captureWebUrl` merges model/user-provided `viewport` directly into `BrowserWindow` dimensions. Extremely large, negative, or non-finite width/height values can throw, allocate excessive GPU/bitmap memory, or destabilize the Electron process during preview capture. Fixed by coercing viewport dimensions to finite integers and clamping to a safe 100..4096 range before constructing `BrowserWindow`. Related code: `src/main/services/previewService.js:84-96`, `src/main/services/previewRunner.js:66-74`.

### `src/main/services/projectContext.js`

**Bugs / notes:**

- **FIXED in `6f2da62` (v46.21.0) — HIGH — project-root containment is lexical and can be bypassed through symlinks/junctions.** `resolvePath` checks `path.relative(projectRoot, resolved)` without resolving symlinks. If the project contains a symlink/junction such as `out -> C:\Users\...` or `out -> /etc`, Code Mode and plugin fs operations can pass a relative path like `out/secret.txt`; the lexical check sees it under the project root while filesystem operations follow the link outside the root. This undermines Code Mode's documented project containment. Fixed by using `fs.realpath` on the root and target (or nearest existing parent for new files) before allowing reads/writes, and rejecting paths whose real target escapes the project root. Related code: `src/main/services/projectContext.js:155-193`, `src/main/services/pluginManager.js:316-320`, `src/main/services/previewService.js:23-27`.

### `src/main/services/projectDetector.js`

**Bugs / notes:**

- TBD

### `src/main/services/worktreeManager.js`

**Bugs / notes:**

- **FIXED in `fix-batch-6` (`1a6e751`) — HIGH — worktree sync can write outside the main checkout via `../` touched paths.** `syncWorktreeFiles` accepts `relPaths`, normalizes backslashes, then does `path.join(worktreeRoot, normalized)` and `path.join(mainRoot, normalized)` without rejecting absolute paths or `..` segments. If a child session records a touched path such as `../victim.txt`, the sync step can copy from outside the worktree and overwrite outside the main project. Fixed by rejecting `../` and absolute paths in `syncWorktreeFiles` so source/destination cannot escape `worktreeRoot`/`mainRoot`. Related code: `src/main/services/worktreeManager.js:145-165`, `src/code/loop/milestoneSubagents.js:121-128`.
- **FIXED in `fix-batch-6` (`1a6e751`) — MEDIUM — git worktree commands are built as shell strings with quoted paths.** `createRunWorktree`, `cleanupWorktree`, and milestone variants call `execSync` with interpolated branch/worktree paths. Session ids are sanitized, but the generated worktree path includes `projectRoot`; a repository path containing a double quote or shell metacharacter can break quoting and change the command. Fixed by replacing shell-string `execSync` calls with `execFileSync('git', [...], { cwd })` so paths/branches are argv values, not shell syntax. Related code: `src/main/services/worktreeManager.js:67-75`, `src/main/services/worktreeManager.js:82-94`, `src/main/services/worktreeManager.js:114-122`, `src/main/services/worktreeManager.js:129-141`.
- **FIXED in `fix-batch-6` (`1a6e751`) — LOW — truncated worktree names can collide and silently reuse the wrong checkout.** `branchName`/`worktreePath` truncate sanitized session ids to 40 characters, and `milestoneKey` truncates parent/milestone ids. If two sessions share the same prefix, `createRunWorktree` returns `{ reused:true }` for an existing path without checking its branch/session ownership, so a later isolated run can reuse stale files from an unrelated earlier run. Fixed by including a short hash of the full id in branch/path names and verifying branch ownership before reusing an existing path. Related code: `src/main/services/worktreeManager.js:14-22`, `src/main/services/worktreeManager.js:24-35`, `src/main/services/worktreeManager.js:55-65`, `src/main/services/worktreeManager.js:102-112`.

## Batch 7 — Renderer

### `src/renderer/app.js`

**Bugs / notes:**

- **FIXED in `fix-batch-7` — HIGH — imported/history-restored chat content can execute HTML/JS in the renderer.** `addMessage('user', text)` assigns user content directly to `innerHTML`, assistant content is passed through `markedParse` without visible sanitization, and saved `modeSnapshots` are restored wholesale with `messagesContainer.innerHTML`. Imported sessions and persisted history therefore become a stored renderer-XSS vector; in web mode the script can read `localStorage.auth_token`, and in Electron it can invoke any exposed `window.api` channel allowed by the preload whitelist. Fixed by rendering user messages with `textContent`, wrapping markdown rendering in a strict allowlist sanitizer, and sanitizing mode snapshots on save/restore. Related code: `src/renderer/app.js:792-797`, `src/renderer/app.js:1202-1212`, `src/renderer/app.js:1530-1535`, `src/renderer/app.js:1765-1774`, `src/renderer/ui/historyPersistence.js:23-28`.
- **FIXED in `fix-batch-7` — MEDIUM — web auth tokens are stored in `localStorage` and exposed to any renderer XSS.** The web polyfill reads `localStorage.getItem('auth_token')` for `/api/invoke` and `/api/events`, and login stores the bearer token back into localStorage. Combined with the unsanitized chat/history rendering surfaces, any injected script can exfiltrate the token and call tool-capable endpoints until logout/restart. Fixed by issuing web sessions as HttpOnly/SameSite cookies, using cookie-backed `/api/invoke`/SSE auth after reload, and keeping `localStorage` token persistence only on the Electron path. Related code: `src/renderer/app.js:46-55`, `src/renderer/app.js:72-86`, `src/renderer/app.js:1217-1235`, `src/renderer/app.js:1315-1320`.
- **FIXED in `fix-batch-7` — LOW — attachment names are injected as HTML when rendering attachment tags.** `renderAttachments` builds `tag.innerHTML` with `file.fileName` from the selected/imported file. Browser `File.name` and Electron `path.basename` are attacker-controlled strings; a name containing HTML can inject markup into the renderer before the message is sent. Fixed by building tags with text nodes and setting `data-index` programmatically instead of interpolating filename into `innerHTML`. Related code: `src/renderer/app.js:1099-1112`.
- **FIXED in `fix-batch-7` — LOW — model ids from the LLM server are interpolated into `<option>` HTML.** `fetchModels` sets `modelSelect.innerHTML = models.map(m => `<option value="${m.id || m}">${m.id || m}</option>`).join('')`. A malicious or compromised configured LLM endpoint can return a model id containing HTML and inject markup into the renderer. Fixed by creating `option` elements with `value`/`textContent` instead of string HTML. Related code: `src/renderer/app.js:1547-1570`.
- **FIXED in `fix-batch-7` — MEDIUM — download links put bearer tokens in URLs.** The click handler for `/download_remote` appends `auth_token` as a query parameter and, in Electron, opens the full URL in the external browser. That exposes the token through browser history, proxy/server logs, crash reports, and `Referer` headers from the external browser. Fixed by intercepting download links with an authenticated `fetch`/blob download instead of appending tokens or opening tokenized URLs externally. Related code: `src/renderer/app.js:2868-2890`, `main.js:760-764`, `main.js:931-949`.
- **FIXED in `fix-batch-7` — LOW — admin user list renders usernames through raw HTML attributes/body.** Usernames come from registration and are later interpolated into `row.innerHTML` in the admin panel (`<strong>...`, `data-user="..."`) without escaping. A username containing markup/quotes can become stored renderer XSS for admins who open the user list. Fixed by validating usernames on registration and building admin rows with text nodes/dataset assignment. Related code: `src/renderer/app.js:1398-1451`, `src/main/services/auth.js:51-70`.

### `src/renderer/effects/bgEffect.js`

**Bugs / notes:**

- TBD

### `src/renderer/entry.js`

**Bugs / notes:**

- TBD

### `src/renderer/modes/agentTools.js`

**Bugs / notes:**

- **FIXED in `fix-batch-7` — MEDIUM — raw-text tool-call recovery can execute destructive tools that were only mentioned in prose.** `extractTextToolCalls` scans all assistant text for JSON/XML snippets naming any active Agent tool, including `write_file`, `delete_file`, `run_shell_command`, and `send_whatsapp_message`. `app.js` executes recovered calls whenever the native `tool_calls` array is empty. If a model quotes an example, repeats user-supplied JSON, or summarizes a malicious page containing `{"name":"delete_file",...}`, the fallback can promote that text into a real tool call. Fixed by allowing mutating tool recovery only from explicit tool-call fences while preserving read-only recovery compatibility. Related code: `src/renderer/modes/agentTools.js:208-328`, `src/renderer/app.js:2567-2587`, `tests/agentTools.test.js:61-70`.

### `src/renderer/modes/chatLoop.js`

**Bugs / notes:**

- **FIXED in `fix-batch-7` — LOW — Agent tool batches can hang forever on plugin hooks or tools.** `executeAgentToolBatch` awaits `plugin-fire-hook` before/after each tool and then awaits the tool execution with no timeout or abort signal. A buggy plugin hook, hung IPC handler, or long-running foreground tool can leave the renderer in a busy state with no per-tool failure event. Fixed by wrapping plugin hooks and tool execution in bounded timeouts and emitting structured timeout failures. Related code: `src/renderer/modes/chatLoop.js:7-14`, `src/renderer/modes/chatLoop.js:20-64`.

### `src/renderer/modes/code.js`

**Bugs / notes:**

- **FIXED in `fix-batch-7` — LOW — Code Mode renderer lock can remain stuck if `code-run` invoke throws.** `run()` sets `codeRunState.isBusy=true`, creates an abort controller, and locks Code Mode before awaiting `window.api.invoke('code-run', ...)`, but the cleanup that clears `isBusy`, `abortController`, and the code lock runs only after the await returns. If IPC throws/rejects before returning a result, the busy state can stay set and the UI remains locked until reload. Fixed by wrapping `code-run` invoke cleanup in `finally`. Related code: `src/renderer/modes/code.js:351-408`.

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

- **FIXED in `fix-batch-8` (`ea9efcf`) — MEDIUM — long-option variants bypass catastrophic command blocking.** The guardrail blocked simple `rm -rf /`, `chmod -R ... /`, and `chown -R ... /` forms, but the regexes only understood short option clusters in fixed positions, so `rm --no-preserve-root -rf /`, `chmod --recursive 777 /`, and `chown --recursive root /` slipped through. Fixed by replacing the position-sensitive regexes with token-based checks (`recursiveRootCommand`) that split the command on shell separators and flag any `rm`/`chmod`/`chown` invocation carrying a recursive flag (short cluster or `--recursive`) together with a root/home target, regardless of where long options like `--no-preserve-root` appear. Regression tests in `tests/batch8Fixes.test.js`. Related code: `src/shared/commandPolicy.js:13-66`.

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

- **FIXED in `fix-batch-8` (`ea9efcf`) — MEDIUM — ripgrep backend bypasses `.xkaliberignore` filtering.** `grepProject` prefers `grepWithRg` whenever `rg` is installed, but that path never loaded `.xkaliberignore` and never filtered returned paths with `isIgnored`; only the Node fallback did, so secrets/generated artifacts that `globFiles`/`list_project`/`grepNode` hide could be surfaced by the default grep path. Fixed by loading the ignore set in `grepWithRg`, passing `.xkaliberignore` as `--ignore-file`, excluding the `DEFAULT_IGNORE` dirs via `--glob !dir/`, and post-filtering every hit through `isIgnored` so both backends behave identically. Regression test in `tests/batch8Fixes.test.js`. Related code: `src/shared/grepTool.js:1`, `src/shared/grepTool.js:22-58`, `src/shared/ignoreFilter.js:10-24`.
- **FIXED in `fix-batch-8` (`ea9efcf`) — LOW — Code Mode grep ignores the model's glob filter.** The Code tool executor called `grepProject(root, a.pattern, a.glob || '**/*')`, but `grepProject` expects an options object, so the bare string had no `opts.glob`/`opts.caseInsensitive`/`opts.maxHits` and the glob filter was silently dropped. Fixed by passing `grepProject(root, a.pattern, { glob: a.glob || '**/*' })`. Related code: `src/code/tools/executor.js:330-335`, `src/shared/grepTool.js:100-106`.

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

- **FIXED in `fix-batch-8` (`ea9efcf`) — MEDIUM — `validatePublicFetchTarget` allows localhost/private-network SSRF targets.** The helper was documented as allowing arbitrary public HTTP(S) hosts while blocking internal pivots, but it only called `isBlockedHost` (metadata/link-local/ULA), so it accepted loopback and RFC1918/private hosts plus numeric/hex/octal and IPv4-mapped-IPv6 loopback forms (`http://2130706433/`, `http://0x7f000001/`, `http://127.1/`, `http://[::ffff:127.0.0.1]/`). Fixed by adding `isInternalHost` (with an inet_aton-style `parseIPv4` and range checks for loopback, RFC1918, CGNAT, link-local, multicast and IPv4-mapped IPv6) and rejecting any internal host in `validatePublicFetchTarget`; preview loopback access is preserved via `validatePreviewUrl`'s explicit fallback. DNS-name rebinding is documented as out of scope (no DNS resolution). Regression tests in `tests/batch8Fixes.test.js`. Related code: `src/shared/netGuard.js:20-110`, `src/main/ipc/agent.js:337-343`, `src/main/services/pluginManager.js:326-393`, `src/main/services/pluginInstaller.js:55-56`, `src/main/services/pluginInstaller.js:116-119`.

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

- **LOW — action-log state is not isolated to the throwaway harness directory.** The script calls `createActionLog(userDataPath)`, but `createActionLog` expects an object with `userDataPath`; a string argument makes `deps.userDataPath` undefined, so the log file falls back to `./action-log.json` in the process working directory. The 100-task battery can therefore create or reuse a real repo/cwd action log, leave it behind after cleanup, and let stale actions affect the review/undo tasks. Fix: call `createActionLog({ userDataPath })` and delete any accidental cwd log in a one-time migration/cleanup if needed. Related code: `scripts/agent-assistant-100-e2e.js:57-70`, `src/main/services/actionLog.js:20-30`, `scripts/agent-assistant-100-e2e.js:803-808`.

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

- **LOW — harness executes model-created filenames through a shell string.** The `runFile` helper builds `execSync(`${runner} "${absPath}" ${args}`, ...)` and `fileFor()` chooses a file by basename from the model-controlled workspace. A generated filename containing a double quote or shell metacharacters can break the quoted path and cause the post-task checker to run unintended shell syntax, outside the app's normal `commandPolicy` path. Fix: use `execFileSync(runner, [absPath, ...argsArray], { cwd: WS, ... })` and keep task arguments as argv arrays. Related code: `scripts/code-mode-100-e2e.js:102-114`.

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

- **LOW — password-assisted share links cannot log in because auth args use the wrong shape.** The helper posts `{ channel:'auth-login', args:[username, password] }` to `/api/invoke`, but the auth IPC handler expects a single object argument `{ username, password }`. The web proxy spreads the array into the handler, so `auth-login` destructures the username string and receives `username/password` as `undefined`; any run with `AGENT_SMITH_SHARE_PASSWORD` fails instead of appending a token. Fix: send `args: [{ username, password }]` (and consider avoiding query-string tokens altogether; the renderer download-token leak is already recorded). Related code: `scripts/print-download-link.js:68-75`, `main.js:872-915`, `src/main/ipc/auth.js:11-17`.

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

- **LOW — example beforeToolCall hook reads the wrong payload field.** The example logs `payload.toolName`, but both the renderer Agent loop and Code Mode executor fire `beforeToolCall` with `{ tool: name, name, args }`. The example therefore logs `about to run tool: undefined`, which makes the documented hook template misleading for plugin authors. Fix: use `payload.tool || payload.name` (or update hook payloads/docs to consistently include `toolName`). Related code: `src/examples/plugins/hello/hooks/audit.js:6-9`, `src/renderer/modes/chatLoop.js:25-28`, `src/code/tools/executor.js:111-114`.

### `src/examples/plugins/hello/plugin.json`

**Bugs / notes:**

- TBD

### `src/examples/plugins/hello/tools/echo.js`

**Bugs / notes:**

- TBD

### `src/ghosttrace/index.js`

**Bugs / notes:**

- **LOW — GhostTrace run ids are used in paths and shell commands without validation.** `PipelineTrace` accepts caller-supplied `run_id` strings, `generateReport`/`exportBundle` interpolate them into output paths, and `exportBundle` builds a shell command containing both `zipPath` and `run_id`. A crafted trace/run id containing path separators, quotes, or shell metacharacters can make diagnostic export write outside the intended GhostTrace folders or execute unintended shell syntax when the bundle is exported. Fix: restrict run ids to a safe slug (`[A-Za-z0-9_-]+`) at construction/export time, use `path.basename`/containment checks for bundle paths, and replace the shell-string `execSync` zip call with `execFileSync('python3', ['-m', 'zipfile', '-c', zipPath, runId], { cwd: RUN_BUNDLES_DIR })`. Related code: `src/ghosttrace/index.js:47-51`, `src/ghosttrace/index.js:173-205`, `src/ghosttrace/index.js:208-241`, `scripts/ghosttrace-cli.js:9-14`.

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
