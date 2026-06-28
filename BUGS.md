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

- TBD

### `src/code/governor/qualityMonitor.js`

**Bugs / notes:**

- TBD

### `src/code/governor/readiness.js`

**Bugs / notes:**

- TBD

### `src/code/governor/smokeTest.js`

**Bugs / notes:**

- TBD

### `src/code/governor/webValidators.js`

**Bugs / notes:**

- TBD

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

- TBD

### `src/code/loop/missingRefGuard.js`

**Bugs / notes:**

- TBD

### `src/code/loop/phases.js`

**Bugs / notes:**

- TBD

### `src/code/loop/planningPhase.js`

**Bugs / notes:**

- TBD

### `src/code/loop/reasoningStrip.js`

**Bugs / notes:**

- TBD

### `src/code/loop/runCodeTask.js`

**Bugs / notes:**

- TBD

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

- TBD

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

- TBD

### `src/main/ipc/agent.js`

**Bugs / notes:**

- TBD

### `src/main/ipc/auth.js`

**Bugs / notes:**

- TBD

### `src/main/ipc/code.js`

**Bugs / notes:**

- TBD

### `src/main/ipc/edit.js`

**Bugs / notes:**

- TBD

### `src/main/ipc/git.js`

**Bugs / notes:**

- TBD

### `src/main/ipc/history.js`

**Bugs / notes:**

- TBD

### `src/main/ipc/index.js`

**Bugs / notes:**

- TBD

### `src/main/ipc/ledger.js`

**Bugs / notes:**

- TBD

### `src/main/ipc/lmStudio.js`

**Bugs / notes:**

- TBD

### `src/main/ipc/memory.js`

**Bugs / notes:**

- TBD

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

- TBD

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

- TBD

### `src/main/services/auth.js`

**Bugs / notes:**

- TBD

### `src/main/services/browserVerify.js`

**Bugs / notes:**

- TBD

### `src/main/services/changeLedger.js`

**Bugs / notes:**

- TBD

### `src/main/services/editEngine.js`

**Bugs / notes:**

- TBD

### `src/main/services/lmStudioManager.js`

**Bugs / notes:**

- TBD

### `src/main/services/memory.js`

**Bugs / notes:**

- TBD

### `src/main/services/pluginHost.js`

**Bugs / notes:**

- TBD

### `src/main/services/pluginInstaller.js`

**Bugs / notes:**

- TBD

### `src/main/services/pluginIntegrity.js`

**Bugs / notes:**

- TBD

### `src/main/services/pluginManager.js`

**Bugs / notes:**

- TBD

### `src/main/services/pluginSandbox.js`

**Bugs / notes:**

- TBD

### `src/main/services/pluginSandboxRunner.js`

**Bugs / notes:**

- TBD

### `src/main/services/previewRunner.js`

**Bugs / notes:**

- TBD

### `src/main/services/previewService.js`

**Bugs / notes:**

- TBD

### `src/main/services/projectContext.js`

**Bugs / notes:**

- TBD

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
