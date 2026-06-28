# Agent Smith Changelog

## [46.15.0] - 2026-06-27 — Code Mode: real-browser runtime verification

Code Mode only — Chat and Agent Mode behavior is unchanged.

### Added
- **The completion gate now verifies a built web app actually RUNS, in a real browser.** Static checks (references, syntax, VM smoke) can't catch the open-ended space of "loads but doesn't work" — `import { X }` where the module doesn't export X, `window.App` undefined, an exception on init, a 404. The gate now serves the project over HTTP and loads it for real (hidden Electron `BrowserWindow` in the app; Puppeteer injected in tests), capturing uncaught exceptions, module errors and failed requests. Each becomes a `[RUNTIME]` message: the run is blocked AND the exact error is fed back to the model to fix next turn — instead of the gate passing an app that doesn't run. Fail-open (never blocks on infrastructure failure); disable via `XK_CODE_NO_RUNTIME_VERIFY=1`.

  Proven with a real browser: an app with a wrong import name is blocked with *"does not provide an export named 'KanbanState'"*; a wiring bug the normalizer repairs (`const App` used as `window.App`) loads cleanly and passes. Tests: `runtimeVerify.test.js`, `runtimeGate.test.js`.


## [46.14.1] - 2026-06-27 — Code Mode: converge multi-file wiring consistently

Code Mode only — Chat and Agent Mode behavior is unchanged.

### Fixed
- **Make the multi-file web repair converge instead of flip-flopping across gate passes.** The gate runs repeatedly as the model edits, so the repair must drive the whole project to ONE consistent strategy. 46.14.0 "left real module apps untouched", but a prior pass could have already downgraded the tags to classic while the files still used `import`/`export` — leaving `<script>` + `export` → "Unexpected token 'export'" (the exact state an end-to-end build landed in). Now: if any file uses real import-wiring, every local `<script>` is forced back to `type="module"`; otherwise tags are forced to classic and module syntax is stripped — and in both cases referenced `window.*` globals are exposed. Verified in a real browser for both classes (3 columns, 1 button, zero errors). Tests: `webNormalizeProject.test.js` (now 6).


## [46.14.0] - 2026-06-27 — Code Mode: deterministically repair multi-file web wiring

Code Mode only — Chat and Agent Mode behavior is unchanged.

### Fixed
- **The #1 reason a "built" multi-file app didn't actually run: inconsistent module/global wiring.** Local/coder models mix strategies unpredictably. The verification step now deterministically repairs both failure classes before judging the build:
  1. classic `<script>` + ES-module syntax (`import`/`export`) → strip the syntax (already shipped in 46.13.1), and
  2. **`type="module"` + code that relies on `window.*` globals** (e.g. `const App = {}` referenced as `window.App` — module scope means `window.App` is never set, so the app dies on load with "Cannot read properties of undefined") → downgrade the tags to classic and expose the referenced top-level declarations on `window`.

  Real ES-module apps (files that `import` each other) are detected and left untouched. Verified in a real browser, before vs after on the exact failure: `window.App` `undefined`→`object`, columns `0`→`3`, buttons `0`→`1`, errors → none. Tests: `webNormalizeProject.test.js`. Suite 454/454.


## [46.13.4] - 2026-06-27 — Fix: welcome page covering the activity timeline

### Fixed
- **The "AGENT SMITH" welcome/empty-state overlay stayed on top of the live activity timeline during a run.** The empty-state is hidden by `updateEmptyState`, which was only called at `run_start` (before any content exists). The timeline inserts its rows into `#messages` but never re-checked the empty-state, and system messages now render as toasts (not inline `.message` nodes), so nothing re-hid the welcome — it sat in front of the live timeline. The timeline now re-checks the empty-state whenever it inserts content (single choke point: `insertBeforeAnchor`). Verified in a real browser: the welcome's `display` goes `flex`→`none` once the first turn renders. Not caused by the preview-approval guard (v46.13.3), which is unrelated and correct.


## [46.13.3] - 2026-06-27 — Code Mode: Preview no longer hijacks plan approval

Code Mode only — Chat and Agent Mode behavior is unchanged.

### Fixed
- **The Preview drawer auto-opened during planning/approval and blocked the Build Plan / "Approve & Run" controls.** Root cause: `show_preview` is a read tool, so the model can call it during the PLANNING phase (read-only exploration); the resulting preview event opened the drawer over the plan sidebar (a stale preview from a prior run could too). The renderer now **suppresses the automatic preview-drawer open while the plan is in the planning/approval phase** — the approval UI keeps priority. Preview content is still rendered (a later manual open shows it), and the drawer auto-opens normally once execution begins. Manual preview, `show_preview` during execution, and `browser_verify` are all unaffected. Pairs with the prior fix that clears a stale preview at run start.


## [46.13.2] - 2026-06-27 — Code Mode: clear stale preview at run start

Code Mode only — Chat and Agent Mode behavior is unchanged.

### Fixed
- **An empty preview drawer left over from a prior run blocked the plan at the start of a new run** — you had to manually exit preview mode to reach plan mode. A new Code Mode run now clears any lingering preview drawer up front (on `run_start` / `planning_start`), so the planning/plan view is visible immediately. Mid-run previews opened by `show_preview` during execution are unaffected.


## [46.13.1] - 2026-06-27 — Code Mode: auto-repair module/classic script mismatch

Code Mode only — Chat and Agent Mode behavior is unchanged.

### Fixed
- **The #1 reason built web apps didn't actually run: module-vs-classic script mismatch.** Local models (even coder models like qwen3-coder) routinely write `import`/`export` in `.js` files that `index.html` loads as classic `<script src>` — which throws "Unexpected token 'export'" and the app is dead on load. Code Mode now deterministically strips ES-module syntax from classic-loaded scripts during verification (they share state via the global scope), so the app runs. Proper `type="module"` apps are untouched. Model-independent — no longer relies on the model getting it right.

Verified end-to-end in a real headless browser: a multi-file Kanban app built by qwen3-coder (with constrained decoding) now loads with **zero JS errors**, renders its columns, and a card added through the UI appears in the DOM.


## [46.13.0] - 2026-06-27 — Code Mode: constrained tool-call decoding (opt-in)

Code Mode only — Chat and Agent Mode behavior is unchanged.

### Added
- **Constrained tool-call decoding for local models (opt-in: `XK_CODE_CONSTRAIN_TOOLS=1`).** Local/reasoning models often narrate ("I'll write index.html") or emit malformed tool calls instead of actually calling a tool, which stalls multi-file builds. When enabled, Code Mode sends the advertised tools to LM Studio as a `response_format` `json_schema` union (structured-output / constrained decoding), so the model can ONLY emit a valid `{name, arguments}` tool call — it physically cannot malform or narrate. A synthetic `attempt_completion` branch lets it still signal "done" (handled as a normal no-tool-call turn). **Default OFF**, so current behavior is unchanged. Verified against `qwen3-coder-30b`: produces a valid tool call via the constrained path. Unit tests: `constrainTools.test.js`. Suite 440/440 with the feature off.


## [46.12.7] - 2026-06-27 — Code Mode: fix false "verified" on reused workspaces

Code Mode only — Chat and Agent Mode behavior is unchanged.

### Fixed
- **CRITICAL: a web build could be falsely reported "✅ COMPLETE (verified)".** The completion gate located the web entry (`index.html`) only among files written in the *current run*. In a reused workspace where `index.html` already existed from an earlier run but this run only wrote a trivial file (e.g. `utils.js`), the gate skipped ALL web checks ("no web project") and passed on whatever parsed — even though `index.html` referenced 7 files that were never created. The gate now also locates an `index.html` on disk (root or an immediate subdir) for a web-app goal and validates its references + smoke test, so a partially-built app correctly reports INCOMPLETE. A host Electron app's own `index.html` is excluded (it isn't the deliverable). Verified against the exact failing scenario.

Known minor limitation: the HTML reference extractor parses only quoted attributes (`src="x.js"`); unquoted attributes are not checked (rare). Also recommended: run each Code Mode build in a **fresh** workspace — reusing one across tasks leaves stale files (and a stale `.agentsmith/PLAN.md`) that confuse the build.

## [46.12.6] - 2026-06-27 — Code Mode: retry on model stall

Code Mode only — Chat and Agent Mode behavior is unchanged.

### Fixed
- **A single model stall no longer ends the whole run.** Local/reasoning models intermittently stall mid-stream (the 60s idle timeout fires). Previously that error ended the run immediately, abandoning a build that had already written some files with the rest missing. Now a stall retries the turn on a fresh request (up to 4 consecutive; `XK_CODE_STALL_RETRIES`), and the no-progress and max-turn guards still bound the run. Verified live: a build survived 4 stalls and kept going for ~10 minutes instead of dying on the first.

This is a **resilience** improvement, not a capability one. A model that stalls on a large fraction of its turns still cannot reliably complete very large multi-file specs in a reasonable time — use a coder model (e.g. Qwen2.5-Coder) for ambitious builds; the runtime advisory flags this.

## [46.12.5] - 2026-06-27 — Code Mode: multi-file build reliability

Code Mode only — Chat and Agent Mode behavior is unchanged.

### Changed / Fixed
- **Multiple files per turn (was one-file-per-turn).** The system prompt and the missing-file recovery nudge previously pushed "ONE file per turn" / "ONE tool call", fragmenting multi-file builds across many turns (each a stall / lose-the-plan risk — the cause of a Kanban build leaving 8 referenced files uncreated). The model is now told it MAY emit several `write_file` calls in one turn; observed batching up to **6 files in a single turn**.
- **Anti-"lazy" prompting.** The system prompt now demands complete, working code — never placeholder comments, stubs, "..." elisions, or "TODO: implement" in place of real logic.
- **Web module-style guidance.** For static/offline web apps, instruct classic `<script src>` (no `import`/`export`; share via `window` globals) — ES modules break over `file://` (CORS) and `import`/`export` in a plain script throws a syntax error.
- Updated the stale "~400 lines" hint in the prompt to ~1000 (matches the write_file cap).

Verified by re-running a multi-file Kanban-class build (GLM in LM Studio): **all** linked files created (was 1 of 8), **zero** dangling references (was 8), batching up to 6 files/turn, and the build reaching `done`. Remaining run-to-run variance is model consistency — the runtime advisory recommends a coder model.

## [46.12.4] - 2026-06-27 — Code Mode: larger single-file writes

Code Mode only — Chat and Agent Mode behavior is unchanged.

### Fixed
- **`write_file` no longer rejects complete source files at 400 lines.** Real multi-file apps have modules of 400–800 lines; a complete 449-line file was bounced with "Content too large (max 400)", forcing weak models into a fragile write-the-first-400-then-append dance that derailed ambitious builds (e.g. a Kanban app whose `utils.js` was rejected, after which the model stalled leaving 8 referenced files uncreated). Raised the line cap to **1000**. This only ever affected *complete* content — real output truncation is still handled separately (finish_reason=length → append chunks), and the 64KB byte cap remains the hard size backstop. Verified by building a 525-line module in a single write.

## [46.12.3] - 2026-06-27 — Code Mode: no-progress early stop

Code Mode only — Chat and Agent Mode behavior is unchanged.

### Fixed
- **Runs no longer burn all 40 turns doing nothing.** Code Mode is a build/edit loop, but its early-stop only caught tool *errors* (5) and *duplicate* calls (8). A model that explored read-only every turn (read_file/grep/list) never tripped either and ground to the max-turn limit having written zero files — reported as UNVERIFIED. Added a no-progress guard: if no file is written for N consecutive turns (default 12, override with `XK_CODE_MAX_NOWRITE_TURNS`), the run stops early with an honest message — suggesting Chat/Agent mode for analysis/Q&A, or restating the task as a concrete build/edit. Writing a file resets the counter, so legitimate exploration-before-writing is unaffected.

## [46.12.2] - 2026-06-27 — Code Mode: generic (de-gamed) file-recovery nudges

Code Mode only — Chat and Agent Mode behavior is unchanged.

### Fixed
- **Recovery nudges were game/Pac-Man-framed.** When a web build left a linked file missing (e.g. `index.html` referencing a `script.js` that wasn't created), the harness told the model to build "the complete game: state, input, loop, win/lose" and referenced `pacman/` paths — misleading for non-game apps (Kanban boards, dashboards, etc.) and a cause of runs stalling to max turns. Nudges are now generic; game-specific hints apply only to actual game goals.
- **Missing-file nudges enforce same-folder placement.** They now state the exact target path and that the file must be a sibling of the HTML that links it. The common failure was the model writing the file in a different directory or under a bare name, leaving a dangling reference.

Verified by re-running a Kanban build that previously failed at max turns (files split across `site/` and `src/`, dangling references): it now completes in ~20 turns with `index.html`/`style.css`/`script.js` in one folder, no dangling references, and runs in a browser (3 columns, no JS errors).

## [46.12.1] - 2026-06-27 — Code Mode: reasoning-model advisory + reasoning auto-collapse

Code Mode only — Chat and Agent Mode behavior is unchanged.

### Added
- **Reasoning-model advisory.** When Code Mode detects at runtime that the selected model is a reasoning model (emits `reasoning_content` or inline `<think>`), it shows a one-time, non-blocking notice that a coder model (e.g. Qwen2.5-Coder) is recommended for builds. Detected by behavior, not by model name — so it never wrongly blocks a capable model. Code Mode still runs with any model.
- **Reasoning auto-collapse.** A turn's "Thinking" panel collapses when the next task/turn begins, and each turn's reasoning starts fresh — keeping the timeline readable on long runs.

## [46.12.0] - 2026-06-27 — Code Mode robustness: anti-freeze, reasoning models, code map

Code Mode only — Chat and Agent Mode behavior is unchanged.

### Added
- **Run watchdog + heartbeat.** Code Mode emits periodic `heartbeat` events (elapsed/idle/phase) and converts a genuine async stall into a clear `WATCHDOG_STALL` error instead of an invisible freeze. Tunable via `XK_CODE_HEARTBEAT_MS`, `XK_CODE_INACTIVITY_MS`, `XK_CODE_MAX_RUNTIME_MS`.
- **Ranked code map.** The first-turn bootstrap now includes a `[CODE MAP]` of key project symbols (functions/classes/exports), ranked by entrypoint/descriptive heuristics, so small models can locate code in an existing project without reading the whole tree. Empty for greenfield. Dependency-free.
- **Reasoning-model handling.** Detects when a model burns its whole reply budget on internal reasoning and emits empty output (`finish_reason: length`), then retries with a larger budget and a "stop reasoning, act now" nudge. Handles both the `reasoning_content` and `reasoning` stream fields and strips inline `<think>…</think>` from content before tool/edit parsing.
- **docs/CODE_MODE_MODELS.md** — guidance on choosing coder (non-reasoning) models, the LM Studio VRAM/`lms` model-switch steps, and watchdog env knobs.

### Fixed
- **Clearer model-load errors.** A model that fails to load in LM Studio now surfaces an actionable message instead of a generic HTTP error.
- **Bounded plugin tool calls** (2-min timeout) and **timeout-guarded smoke verification** (VM engine by default; jsdom opt-in via `XK_SMOKE_JSDOM`) so a misbehaving tool or infinite loop can't hang a run.
- **Pac-Man scaffold scope.** The last-resort recovery scaffold no longer fires for generic "game" goals, so a non-Pac-Man build can't be overwritten with Pac-Man code.

## [46.11.0] - 2026-06-24 — Desktop polish, sidebar UX, docs sync

### Added
- **Frameless desktop shell.** Electron runs with `frame: false` and a minimal custom titlebar — drag strip plus **− □ ×** on the top-right (not in the sidebar). Window IPC: `window-minimize`, `window-maximize`, `window-close`, `window-is-maximized`.
- **Official desktop icon.** AS monogram assets in `build/icons/`; Linux `npm run install-desktop` writes a `~/.local/share/applications/agent-smith.desktop` entry with `StartupWMClass=agent-smith` for correct taskbar/dock identity.

### Changed
- **Sidebar polish.** Lighter card surfaces and calmer green accents (less glow); **TUNING**, **CODE**, and **CONNECT** nested under a single **ADVANCED** section.
- **Phone QR UX.** 📱 stacked above 📁 in the composer; QR opens as a centered modal (moved to `<body>` so mobile sidebar transforms cannot clip it). Fallback QR generation in preload when `get-remote-qr` IPC is unavailable.
- **Linux window chrome.** `ozone-platform-hint: x11` and `WM_CLASS=agent-smith` for consistent frameless behavior; login/admin overlays start below the titlebar so close/minimize stay reachable.

### Fixed
- **WhatsApp link on machines without Puppeteer Chromium.** `resolveChromeExecutable()` falls back to system Chrome/Chromium before failing; onboarding explains `npx puppeteer browsers install chrome` when nothing is found.
- **Blank or missing phone QR** when tunnel/LAN URL was present but image generation failed.

### Removed
- **Live browser automation** (`agentBrowser`) and interactive `browser_*` agent tools — use **Code Mode `browser_verify`** (headless HTML check), **`show_preview`**, or **`web_search` / `fetch_url`** (read-only) instead.
- **Credential Vault** (`credentialVault`) and `vault_*` tools — no stored-password tool surface; regression test blocks credential tools from Agent Mode.
- **Persistent chat watchers** (`chatWatcher`) and `watch_chat_*` tools — removed with their `agent-browser-*` / `vault-*` / `chatwatch-*` IPC channels.

> **Still available:** Code Mode `browser_verify`, sidebar **Preview** (`show_preview`), Agent **`web_search` / `fetch_url`**, optional **WhatsApp** linking (`whatsapp-*` IPC, opt-in dep).

## [46.10.0] - 2026-06-24 — Phone connect, zero‑setup cockpit, gate + tool‑call fixes

### Added
- **Open on your phone (QR).** A new 📱 button in the composer opens a themed popup with a scannable QR of the phone‑reachable URL — the public Cloudflare tunnel link if it's up, otherwise the LAN URL — with a **REMOTE / LAN badge** so you know which kind of link you're scanning. Replaces the old sidebar "Web Remote URL" text readout. (`get-remote-qr` IPC via the bundled `qrcode` dep.)
- **WhatsApp onboarding.** When the optional WhatsApp dependency isn't installed, `LINK WHATSAPP` now opens a clear install wizard (what it does, the one‑time `npm install whatsapp-web.js qrcode` command with a COPY button, restart hint) instead of a cryptic error. When it *is* installed, the link QR shows in the same modal with explicit step‑by‑step instructions to scan it from **WhatsApp → Linked Devices → Link a Device** (not the phone camera, which can't read an account‑linking code and shows a dead link).

### Changed
- **Zero‑setup cockpit (less clutter).** Build Mode now **always plans then grinds** to green — the PLAN and GRIND chips are gone (engineered defaults, enforced in code). Removed the unused **ISO** (isolated‑worktree) chip and the **NETRUNNER** chat‑web toggle. The experimental **Milestone Execution** toggles were removed. Manual tuning sliders (Temperature / Thinking Steps / Context) are hidden unless **Auto‑tune** is turned off.
- **Hardware Guard redesigned.** Pulled out of the Advanced drawer into an **always‑visible, compact cockpit strip** (live RAM / GPU VRAM / GPU load with bars that colour amber > 80% and red under pressure), theme‑matched, with a clearly‑labelled **⟳ GPU RESET** button (still confirm‑gated).

### Fixed
- **Code Mode "unverified" on scriptless JS projects.** The completion gate could never validate a bare project that had `*.test.js` files but no `package.json` test script, so correct code kept iterating until the turn cap. The project detector now infers `node --test` for such projects, and the gate also credits the agent's own successful program/test run (exit 0 since the last edit). Lifted the Tests category from 5/10 → 9/10 in the 100‑task battery (incl. red→green "make the failing test pass").
- **Agent Mode dropped malformed tool calls.** A model emitting a tool call as raw JSON in prose with unescaped inner quotes (e.g. `{"command":"echo "x" > f"}`) failed strict `JSON.parse` and was silently dropped. `extractTextToolCalls` now repairs that shape (gated on a known tool name → no false positives). Added regression tests.
- **Data‑parsing hint.** Bootstrap now tells the model to read a data file and split on a delimiter it can actually see (mitigates a CSV pipe‑delimiter hallucination on some small models).
- **Build Mode live preview was blank.** The preview `<iframe>` loaded the auth‑gated `/preview/*` route as a cross‑origin request that can't carry the session cookie, so it had no token and returned HTTP 401 → a white panel even though the built app was fine. The Preview panel now appends the session token to the iframe, snapshot, RELOAD, and OPEN EXTERNAL URLs, so the live preview authenticates and renders the project.

## [46.9.0] - 2026-06-16 — Agent Mode (full host control + trust layer)

### Fixed
- **Chat Mode (critical):** Sending a message did nothing when LM Studio returned an empty model list (its Just‑In‑Time loading mode). `fetchModels` was overwriting the dropdown with an empty list, leaving "no model selected" so every send silently returned. It now never blanks a usable selection, **remembers the last model** (persisted), keeps it usable when the live list is empty (LM Studio loads it on demand), and shows a clear message instead of doing nothing.
- **Agent loop stability:** `pruneChatHistory` (a no‑op) was letting large tool outputs balloon the context → "reloads every step / yellow banner / repeats / hallucinated success". History is now bounded. The text‑JSON tool‑call fallback was generalized beyond `web_search`, and the anti‑loop guard uses a sliding window, ignores read‑only tools, and stops honestly (no false "failed" after a success).
- **Startup/build:** self‑hosted fonts (offline + CSP‑clean), resilient web‑server port binding (no crash if the port is busy), repaired the bundled Electron/electron‑builder.

### Added
- **Full host control in Agent Mode:** whole‑host file read/write/delete + process management (`list_processes`/`stop_process`/`send_input`), guarded by `pathPolicy` (refuses wiping system/home roots) and `commandPolicy`.
- **Web read in Agent Mode:** `web_search` (search the internet) and `fetch_url` (read a page/API as text).
- **Trust layer:** action log of consequential actions (file writes/deletes, shell, sends) with **undo** for file ops; `review_actions`/`undo_action` tools.

### Security / Privacy
- `pathPolicy` blocks catastrophic file targets (refuses wiping system/home roots); `commandPolicy` filters dangerous shell commands.

## [46.9.0] - 2026-06-15

### Fixed
- **UI:** Made the visual web search results block durable so that it properly re-renders from the chat history (`convo` array) when switching modes or reloading the application, ensuring the search sources retrieved are permanently visible in the chat feed.

## [46.8.0] - 2026-06-15
- **UI:** Added a persistent visual results block to the chat feed whenever `web_search` executes. This explicitly shows the user the exact URLs and Titles that were retrieved and injected into the agent context.

## [46.7.0] - 2026-06-15
- **Agent Mode:** Updated system prompt to strictly forbid raw JSON leakage. Rewrote the JSON fallback parser to use regex so it can extract and execute malformed tool calls even if the agent prefixes them with conversational text.

## [46.6.0] - 2026-06-15
- **Agent Mode:** Added a fallback JSON parser for `web_search` tool calls to catch cases where the model incorrectly outputs the raw tool call JSON into the chat stream with unescaped quotes instead of using the proper API schema.

## [46.5.0] - 2026-06-15
- **UI:** Added a visual toast notification in Agent Mode to alert the user when a `web_search` is executed.

## [46.4.0] - 2026-06-15
- **Agent Mode:** Added an automatic system nudge to the `web_search` tool output. This forces the model to immediately summarize search results for the user without waiting for a manual "continue" prompt.

## [46.3.0] - 2026-06-12
- **UI:** Disabled the debug window (DevTools) from opening automatically when the application starts.

**Build Optimization and Version Bump**

### Fixed
- **Build Size Reduction:** Optimized the build process to ensure that previous build artifacts and unnecessary dependencies are not included in the final packages.
- **Maintenance:** Bumped version to 46.2.0 for a fresh release cycle.

## [46.0.0] - 2026-06-11

**Agent Mode Legacy Port**

### Changed
- **Agent Mode Replaced:** Replaced the highly-restricted Agent Mode with the legacy 'Agent sys-access' logic from v41.7 of Xkaliber Agent. This restores full file modification capabilities (`write_file`, `delete_file`) to Agent Mode, effectively unlocking system writes outside of the rigid constraints of Code Mode.

## [45.0.3-hotfix2] - 2026-06-10

**Web Search Hang Fix.**

### Fixed
- **Web Search Timeout:** Added a 15-second timeout to the `web_search` tool (`perform-search` IPC handler). Previously, if DuckDuckGo tarpitted or silently dropped the connection without closing it, the Node.js `fetch` call would hang indefinitely because it lacks a default timeout. This caused the Agent Mode turn loop to freeze indefinitely, preventing the model from ever receiving the tool results and continuing the conversation.

## [45.0.3-hotfix] - 2026-06-10

**Critical Linux Build, UI, and Startup Crash Fixes.**

### Fixed
- **UI Lockup (Blank Scripts):** Fixed an issue where the renderer completely failed to bind event listeners (dead buttons/dropdowns) in packaged builds due to the `esbuild` output directory (`dist`) overlapping with the `electron-builder` output directory. `electron-builder` now outputs to `release/`, preserving the UI `bundle.js` in the archive.
- **Read-Only Filesystem Crash (app.asar):** Fixed a fatal `EACCES`/`EROFS` crash where `ghosttrace` attempted to run `fs.mkdirSync` inside the read-only `app.asar` archive on boot, preventing IPC registration. It now maps its data directory to `~/.config/Agent Smith/ghosttrace` when packaged.
- **Missing Dependencies:** Addressed missing `bcryptjs` dependency which threw exceptions before `auth.js` IPC handlers could mount.
- **Build Configuration:** Added missing `homepage` metadata to `package.json` to satisfy the strict requirements of `electron-builder`'s `.deb` target on Linux.

## [45.0.3] - 2026-06-09

**Agent mode, cross-platform run, and conversation persistence — hardened for release.**
Green on `npm test` (318), harness-eval (17), harness-security (6), `ship-check`, `verify-main-ipc`, `build:renderer`.

### Fixed
- **Agent mode** — `agent-list-directory` returned a pre-joined string but the renderer called `.join` on it (crashed the tool); now returns an array. Foreground `run_shell_command` blocked the whole turn for 5 min when opening a GUI app (browser) — `FG_TIMEOUT_MS` lowered 300s→90s and the model is told to background GUI/long-running launches. Background shell now uses `/bin/sh` (not `bash`, absent on minimal Linux) with an `error` listener so a spawn failure can't crash the main process.
- **Whole-app freeze on send** — the chat/agent stream re-parsed the entire growing markdown buffer per token (O(n²)); now throttled via `createThrottledRenderer`.
- **Reasoning display** — `reasoning_content` (qwen3 etc.) now renders in a collapsible "💭 Reasoning" panel instead of looking frozen while the model thinks.
- **Conversation persistence** — Chat/Agent/Code keep separate, per-mode rendered snapshots (messages + tool cards + reasoning) that survive mode switches and relaunch; switching mid-run no longer loses the reply; the run's bubble re-attaches live when you return. Final-render snapshot ordering and the abort path corrected.
- **Startup resilience** — an optional subsystem (puppeteer/Chromium, LM Studio probe, plugin) throwing no longer prevents IPC handlers from registering ("No handler for auth-register"); each IPC domain registers in isolation with auth first.
- **Auth** — first account is always admin, and if no usable admin exists the next signup is promoted (no lockout); legacy records without a `permissions` object are normalized on load.
- **Security** — `git commit` ran user-controlled message text through a shell (`exec`); now uses `execFile` (argv, no shell) — no injection, correct on Windows too.
- **Linux packaging** — WhatsApp deps (`whatsapp-web.js`/`qrcode` → puppeteer/Chromium) made optional so a clean `npm install` can't fail on them; `package.json` `author` restored (electron-builder `.deb`); `build-renderer` reports an esbuild platform-binary mismatch clearly.

### Added
- `run.sh` / `run.cmd` / `scripts/bootstrap.mjs` — zip-and-run on any OS; detects a cross-platform `node_modules` (electron/esbuild) and reinstalls for the current machine, then launches.
- Regression tests: `editDeathSpiral`, `autonomousGameBuild`, `agentListDir`, `ipcResilience`, `auth`, `whatsappOptional`, `modeHistory`, plus extended `historyPersistence`.

### Docs
- `docs/architecture.md` rewritten to the real `src/code/*` engine + three-mode model (was describing a non-existent `src/agent/*`); `AGENTS.md` folder map corrected.

---

## [45.0.2.1 — internal] Code-mode edit-loop robustness + release cleanup

**Code-mode edit-loop robustness + release cleanup.** Fixes the failure mode where a weak model corrupted a file into an unrecoverable state, removes dead code/features ahead of the test-user release, and locks the three-mode conversation invariant with a regression test. Green on `npm test`, harness-eval (17), harness-security (6), `ship-check`, `verify-main-ipc`, and `build:renderer`.

### Fixed
- **Edit death-spiral** — a weak model was forced onto `append_file` for *revisions* (because `write_file` was capped at 60 lines), which duplicated top-level definitions (five `gameLoop`s) until every `patch` hit "Multiple exact matches" and the run died on "5 consecutive tool errors". Four compounding fixes:
  - `MAX_WRITE_LINES` 60 → 400 (`src/code/tools/executor.js`) so a complete file fits one `write_file`; real truncation is still caught by the existing `finish_reason=length` retry path.
  - `patch` gains `replace_all` + actionable multi-match errors (`src/shared/editFormats.js`, `src/main/services/editEngine.js`, `src/code/tools/schemas.js`) — an escape from the duplicate dead-end.
  - `append_file` refuses to write past `</html>` or to re-declare a top-level symbol already in a `.js` file (`src/code/tools/executor.js`) — steers revisions to `patch`/`write_file`.
  - `EarlyStopDetector` no longer counts a duplicate-skip toward the fatal consecutive-error limit (`src/code/governor/earlyStop.js`).

### Added
- `tests/editDeathSpiral.test.js`, `tests/autonomousGameBuild.test.js` — reproduce the spiral through the real executor and prove a complete game now builds to a verified completion.
- `tests/historyPersistence.test.js` — regression coverage locking the **three separate, persisted conversations** invariant (Chat/Agent/Code round-trip independently; legacy single-array history migrates into Chat only).

### Fixed (startup)
- **"No handler registered for 'auth-register'" / dead IPC on some Linux builds** — `main.js` constructed optional subsystems (pluginManager, previewRunner, browserVerify, lmStudioManager) at module load *before* `registerAllIpc()`. If any threw (puppeteer/Chromium absent, LM Studio probe, a bad plugin), IPC registration never ran, so the window loaded but every channel was unhandled. Those inits are now wrapped (`safeInit`) so they degrade to null instead of aborting startup, and `registerAllIpc` registers each domain in isolation (auth first) so one failing domain can't take down sign-in. Regression: `tests/ipcResilience.test.js`.
- **Login/register now self-heal admin + surface real errors** — first account is always admin, and if no usable admin exists the next signup is promoted (`src/main/services/auth.js`); handlers show the actual failure instead of a dead button. Regression: `tests/auth.test.js`.

### Packaging
- **Zip-and-run on any OS** — added `run.sh` (Linux/macOS), `run.cmd` (Windows), and a dependency-free `scripts/bootstrap.mjs`. The bootstrapper detects when `node_modules` was built for a different OS (an Electron app's `electron`/`esbuild` binaries are native and single-platform) and reinstalls for the current machine automatically, then starts the app. You can now zip the whole folder and run it on Linux or Windows with no manual dependency surgery.
- **WhatsApp deps made optional — fixes recurring "`npm install` fails on Linux"** — `whatsapp-web.js` (a peripheral feature) pulled in **puppeteer**, whose postinstall downloads ~150 MB of Chromium and needs Linux system libs; that was the dependency that broke a clean Linux `npm install` every time. `whatsapp-web.js` + `qrcode` moved to `optionalDependencies` (a failure there no longer aborts the install), and `src/main/lifecycle/whatsapp.js` now lazy-loads them so the app installs/runs without Chromium. WhatsApp linking is opt-in (`npm install whatsapp-web.js qrcode`). No core feature used puppeteer — `browserVerify` uses Electron, not headless Chromium.
- **Restored `author` in `package.json`** — its removal in 45.0.2 broke `npm run dist` on Linux (electron-builder requires it for the `.deb` maintainer field). This, plus a Windows-built `node_modules` shipped in a zip, was the real cause of a friend's "app won't start / can't sign in" on Linux — not the login UI.
- **`scripts/build-renderer.js`** now detects an esbuild platform-binary mismatch (node_modules copied across OSes) and prints an actionable "run `npm install` on this machine" message instead of a cryptic stack trace.
- **README** — added a "Sharing with someone on another OS" section: send source only (never a cross-platform `node_modules`); build Linux artifacts on Linux.

### Removed
- Dead renderer module `src/renderer/ui/sidebarResize.js` (unwired; targeted non-existent DOM).
- Abandoned chat extraction `src/renderer/modes/chat.js` + `router.js` (bundled but unconsumed; live chat path is unchanged).
- Vestigial `src/shared/toolRegistry.js` + test (no runtime importer; live gating is `channelPolicy`/`phases`). Docs repointed to `src/code/tools/schemas.js`.
- ~2.2 MB of working-tree dev trace artifacts; stale `main.js` GPU comment.

## [45.0.2] - 2026-06-08

**Renderer organization + doc hygiene.** Moves UI assets into `src/renderer/`, removes stray third-party product references from package metadata and comments, and updates navigation docs. No agent-loop or IPC behavior changes. Green on `npm test` (304) and `npm run build:renderer`.

### Changed
- **`styles.css` / `styles.overlay.css`** → `src/renderer/styles/base.css` + `overlay.css`; `index.html` link paths updated.
- **Root `renderer.js`** → `src/renderer/app.js`; `index.html`, `main.js` public-file list, and `tests/rendererLoadOrder.test.js` repointed.
- **`README.md`** — project layout table, current key paths, runtime-profile highlight.
- **`AGENTS.md`**, **`docs/architecture.md`**, **`docs/CODE_MODE.md`**, **`SMITH.md`** — paths and folder map aligned with the move.
- **UI/CSS comments** — removed comparisons to other coding-agent products; neutral wording only.
- **`package.json`** — removed stale `System76` author/homepage metadata.

### Removed
- **`JAN_REDESIGN.md`** — obsolete overlay notes (theme lives in `src/renderer/styles/`).

## [45.0.1] - 2026-06-08

**Code-mode write integrity + web-project verification.** Fixes the failure that shipped a broken Pac-Man build (corrupted `style.css`, invisible game) and closes the verification gaps that let it pass the completion gate. Green on `npm test` (286), harness-eval (17), and harness-security (6); `npm run build:renderer` clean.

### Fixed
- **Tool-call extractor field-order corruption** (`src/code/tools/extractor.js`) — `extractLenientWriteCalls` found a write's `content` boundary by walking back from the end of the object, which only held when `content` was the last field. When a model emitted `{…,"content":"…","path":"…"}` (content before path), the `","path":"…"` tail was swallowed into the file (the `}\n","path":"style.css` artifact). Now trims any recognised key that follows `content` before locating its closing quote. Handles escaped and unescaped quotes in content; content-last ordering unaffected.
- **`memory` success-wrapper contract** (`src/main/services/memory.js`) — `addVector`/`queryVectors` returned a bare `{ error }` on embedding failure while the success path returned `{ success: true }`. Both error paths now return `{ success: false, error }` for a consistent wrapper (backward-compatible: `error` is still present).

### Added
- **`detectSerializationArtifacts`** (`src/code/governor/webValidators.js`) — error-level check for leaked tool-call JSON tails (`","path":…`) and backslash-escaped braces (`\{`/`\}`) in any written CSS/JS/HTML file. Defense-in-depth for the extractor fix above.
- **`validateRenderedClassesStyled`** + **`extractJsAppliedClasses`** (`src/code/governor/webValidators.js`) — flags the "invisible game" disconnect where a script renders elements with classes the stylesheet never defines (e.g. JS renders `.cell/.pellet/.pacman/.ghost` while CSS styles `.character/.dot/.powerup`). High precision: only fires when a stylesheet exists and the unstyled classes are the majority of what the script renders.
- All four checks wired into the completion gate (`src/code/governor/completionGate.js`) so they block a premature "done".
- Regression coverage in `tests/auditContinuation.test.js` (9 tests).

## [44.2.0] - 2026-06-06

**Doctrine-driven bloat cut** — implements [`SMITH.md`](SMITH.md): one product path (Build Mode), delete over deprecate, shrink `main.js`.

### Removed
- **`resources/piper/`** (~110MB) — bundled Piper TTS binaries, voice model, and espeak-ng data. `electron-builder` `extraResources` entry removed. Desktop Piper path deleted (`src/main/lifecycle/tts.js`, `tts-speak` IPC). **Browser Web Speech API** TTS remains via the ADVANCED toggle.
- **Chat Mode tool stack** — removed ~130 lines of `AGENT_TOOLS` schemas and ~100 lines of `executeTool` from `renderer.js`. Chat is conversation-only; memory still injects via `searchMemory()`. Retired AGENT toggle hidden in UI.
- **README bloat** — replaced ten version-highlight blocks with a concise current-state README pointing at `SMITH.md`.

### Changed
- **`main.js` slimmed** — WhatsApp IPC → `src/main/lifecycle/whatsapp.js`; Piper TTS → `src/main/lifecycle/tts.js`.
- GhostTrace CLI → `scripts/ghosttrace-cli.js` (`node scripts/ghosttrace-cli.js run`).

## [44.1.0] - 2026-06-06

**Root cleanup — shim removal.** The temporary re-export shims from the `src/` restructure are gone. Purely structural; no behavior changes. Green on `npm test` (148), `npm run ship-check` (7 scenarios), `node scripts/verify-main-ipc.js` (73 channels), and `npm run build:renderer`.

### Removed
- **All 8 root re-export shims** (`agentLoop.js`, `auth.js`, `changeLedger.js`, `contextBuilder.js`, `editEngine.js`, `memory.js`, `planStore.js`, `projectContext.js`) and the **entire `lib/` shim directory** (24 files).
- Every requirer now imports the real `src/...` path directly: `main.js`, the legacy CLIs (`index.js`, `tools.js`, `cli-build.js`, `standalone-server.js`), the test suite, and `scripts/ship-check.js`.
- **`preload.js` intentionally kept** at root (re-exporting `src/preload/index.js`): Electron's `webPreferences.preload` and the web server's static file list reference it by path, so it moves only with the deferred renderer/`main.js` bootstrap relocation.

### Changed
- **Legacy CLI entry points moved into `cli/`**: `cli/index.js` (Ollama CLI), `cli/tools.js`, `cli/cli-build.js`, `cli/standalone-server.js`. Their `require()` paths were repointed (`./src/...` → `../src/...`, `./ghosttrace` → `../ghosttrace`) and `standalone-server.js`'s `cloudflared` lookup adjusted to `../cloudflared`. Invocation is now `node cli/cli-build.js ...` etc. (docs updated). The Electron shell (`main.js`, `preload.js`, `index.html`, `icon.png`) stays at root — conventional for Electron and coupled to `__dirname`/the static web root. *(Renderer CSS/JS moved under `src/renderer/` in 45.0.2.)*
- `create_icon.py` moved into `scripts/`; `.gitignore` now also ignores `.claude/`.

## [44.0.0] - 2026-06-06

**Professional `src/` restructure** — a purely structural release. The flat Electron layout moved into a predictable `src/` tree so humans and AI assistants can navigate it: one folder per job, no 2,000+ line god files, one place to add a tool, and esbuild instead of fragile `<script>` ordering. **No agent behavior, prompt, or feature changes.** Every phase ended green on `npm test` (now 148 tests) and `npm run ship-check`.

### Added — repository structure
- **`src/` tree.** `src/main/` (Electron `services/` + `ipc/` + `server/`), `src/renderer/` (`chat/`, `build/`, `ui/`, `assets/`), `src/agent/` (`loop/`, `tools/`, `context/`, `state/`, `harness/`), and `src/shared/`. See [`AGENTS.md`](AGENTS.md) for the full map.
- **Root shims.** Every moved module keeps a one-line `module.exports = require('./src/...')` re-export at its old path so `cli-build.js`, tests, and external scripts keep working through the migration. *(Removed in 44.1.0 — see above.)*
- **`AGENTS.md`** — primary AI + human entry point: folder map, Build-vs-Chat flow, the "add a tool" checklist, IPC rules, and a "what not to touch" list.
- **`docs/architecture.md`** — process model, run paths, the agent-loop split, IPC domains, and the design for the still-deferred `renderer.js` / `main.js` split.

### Added — esbuild renderer bundle
- **`scripts/build-renderer.js`** + **`src/renderer/entry.js`** bundle the renderer-side agent modules into `dist-renderer/bundle.js`.
- **`index.html`** now loads one bundle script (plus `renderer.js`, still the large DOM script) instead of 12 ordered `<script>` tags.
- **`package.json`**: `esbuild` devDependency; `build:renderer` / `watch:renderer` scripts; `prestart` / `predist` auto-build the bundle.

### Changed — `agentLoop.js` decomposed
- The ~2,350-line god file is now a ~350-line orchestrator in `src/agent/loop/agentLoop.js` that wires focused factory modules through a shared harness `H`: `toolSchemas.js` (pure tool data), `streamCompletion.js` (SSE parse + tool-call extraction), `toolExecutor.js`, `planning.js`, `execution.js`, `review.js`. Exports on `window.XKAgentLoop` / `module.exports` are unchanged.

### Changed — `main.js` IPC handlers extracted to `src/main/ipc/*`
- The ten service-delegating IPC domains moved out of the ~1,770-line `main.js` into per-domain modules — `auth`, `history`, `agent`, `edit`, `project`, `plan`, `ledger`, `git`, `memory`, `plugins` — each exporting `register(ipcMain, deps)` and closing over nothing global. `main.js` builds one `deps` object and calls `registerAllIpc` (`src/main/ipc/index.js`).
- `main.js` **stays at the repo root** as the bootstrap, so `__dirname` is unchanged and the static web server, preload path, and `loadFile` keep working. OS/lifecycle handlers (WhatsApp, TTS, GPU telemetry, app-reset, set-lms-url, the web server, host/env/external-url) intentionally remain inline.
- Verified by `scripts/verify-main-ipc.js`, which loads the real `main.js` under stubbed electron/whatsapp/http/memory and asserts all 73 channels register exactly once and are whitelisted. Splitting `renderer.js` and relocating the `main.js` bootstrap into `src/main/` remain deferred (GUI-only verification) — see `docs/architecture.md`.

### Added — tool registry (kills four-place drift)
- **`src/shared/ipcChannels.js`**: single source of truth for the IPC channel whitelists; `src/preload/index.js` imports it instead of duplicating the lists.
- **`src/agent/tools/registry.js`**: aggregates tool schemas, phases, and IPC channels with integrity checks; **`src/agent/tools/readFile.js`** is the reference colocated-tool module.
- **`tests/toolRegistry.test.js`**: asserts every schema tool has a dispatch case, the reference module stays consistent, and the registry channel list matches the shared source.

### Added — git safety net
- `git init`, plus a `.gitignore` covering `node_modules/`, `dist/`, `dist-renderer/`, ghosttrace artifacts, `.superpowers/`, and OS junk.

### Deferred (documented, not done)
- Splitting `renderer.js` (~2,670 lines of DOM code, loaded as a plain script) and relocating the remaining `main.js` bootstrap into `src/main/index.js` are **designed in `docs/architecture.md`** but not executed, because they require an Electron GUI smoke this environment cannot run. Both stay at the repo root for now.

## [43.1.0] - 2026-06-06

**Gemma Harness** — ports Google ADK's Gemma-specific message adaptation into Agent Smith's OpenAI `/v1/chat/completions` path so Gemma 3n/4B and Gemma 4 models plan, call tools, and build reliably in LM Studio. No ADK Python dependency; pure JS in `lib/gemmaHarness.js`. New tests in `tests/gemmaHarness.test.js`; suite now 142 tests.

### Added — `lib/gemmaHarness.js`
- **`isGemmaModel` / `gemmaVariant`**: auto-detect Gemma models and branch Gemma3 vs Gemma4 (`tool_responses` role for Gemma 4 per ADK).
- **`foldSystemForGemma`**: moves `role: system` content into the first user turn — Gemma chat templates often ignore the system role.
- **`buildGemmaToolPreamble`**: injects an explicit "respond ONLY with `{"name","parameters"}`" block plus the real tool names for the call.
- **`serializeToolTurnsForGemma`**: rewrites assistant `tool_calls` and `role: tool` results into plain text turns so multi-turn builds don't error or stall.
- **`adaptMessagesForGemma`**: orchestrates the above; idempotent (safe when planning/recovery loops re-send a growing message array each turn).

### Changed — model family & prompts
- **`contextBuilder.js`**: Gemma is now its own model family (split out of the `llama` bucket) with a dedicated imperative family prompt; Gemma always gets compact build/planner prompts regardless of the context slider (Smith monologue is a known Gemma failure mode).
- **`lib/smithPersona.js`**: `buildPlannerSystemPrompt` and `buildChatSystemPrompt` accept `{ compact: true }` for Gemma — strips philosophical anchors, keeps guardrails and tool rules.

### Changed — agent loop & chat path
- **`agentLoop.js`**: `adaptOutgoingMessages` runs the harness before every `streamCompletion` (planning, recovery, execution) using that call's actual tool names. ADK's "last valid JSON object" fallback added to `extractToolCallsFromText` for when Gemma emits prose before the tool JSON. `model` threaded into `buildPlanningContext`.
- **`renderer.js`**: chat path (Build Mode off) folds system prompts and uses compact Smith for Gemma models.
- **`index.html`**: loads `lib/gemmaHarness.js` before `contextBuilder.js`.

### Testing
- **`tests/gemmaHarness.test.js`**: detection, variant branching, fold, serialize, preamble, idempotency, non-Gemma pass-through.
- **`tests/agent-loop.test.js`**: `detectModelFamily('gemma-3-4b-it')` → `'gemma'`.
- **`scripts/ship-check.js`**: smoke test for fold + serialize + preamble.

Non-Gemma models (Qwen, Llama, etc.) pass through completely untouched.

## [43.0.0] - 2026-06-05

A **left-panel UX overhaul** plus an inline tool-activity timeline. No engine/agent-loop changes — every fix is in the sidebar markup, the renderer's panel wiring, and the agent run UI's timeline target. Renderer JS references elements by ID, so the markup reorder is behaviour-preserving.

### Changed — sidebar reorganized for user flow (`index.html`, `styles.css`)
- **Instant-access quickbar.** The **BUILD MODE** and **AGENT** toggles are lifted out of any collapsible folder into a new always-visible `.xk-quickbar` at the top of the panel — the two things you reach for most are no longer buried in a section. Styled with a left accent rail + faint glow to read as the panel's primary control.
- **Sections renamed for clarity.** `CHAT` → **MODEL** (model select, temperature, steps, plus the Build-Mode model/context controls), `INTEGRATIONS` → **PLUGINS** (redundant inner "🧩 PLUGINS" label removed).
- **Sections reordered and regrouped.** New top-to-bottom order: quickbar → MODEL → PLUGINS → CONNECTION → WORKSPACE → ADVANCED. `FEATURES` (memory / local-TTS / TTS / Netrunner toggles) folded into **ADVANCED** alongside the WIPE / export / import / sudo / hardware-monitor controls. CONNECTION and WORKSPACE start collapsed.
- **WhatsApp moved to CONNECTION.** The `wa-link-btn` now lives in the CONNECTION section next to the LM Studio server input and host URL, where link/connection actions belong.

### Fixed
- **"📍 Here I am" workspace picker is always visible (`renderer.js`).** The button (and workspace status) were coupled to Build Mode and rendered with `display:none`, so the new WORKSPACE section showed up empty when Build Mode was off. Decoupled in `updateBuildModeUI` and `updateWorkspaceStatus` so the picker is available regardless of mode.
- **Agent tool activity now streams inline in the chat (`lib/agentRunUI.js`).** Tool calls/results and verify failures previously rendered in a separate `#agent-timeline` block detached from the conversation. The timeline now targets `#messages`, so each tool row flows chronologically in the chat column; the plan surface stayed in its drawer. Run reset no longer wipes chat history (it only cleared the old dedicated block).

## [42.3.1] - 2026-06-04

### Fixed
- **Build could spin for many turns doing nothing, then die with `[BLOCKED step null]`.** `submit_plan` was offered (and handled) during the execution phase. A small model that re-emitted `submit_plan` mid-build hit `plan-create`, which made a fresh `awaiting_approval` plan with `currentStepId = null` — wiping the live plan and stranding the loop until the no-progress ceiling killed it. Now `submit_plan` is excluded from the execution tool set, and its handler refuses to recreate a plan that is already approved/executing (covering the text tool-call fallback), steering the model to work the current step or use `add_steps`. Regression-tested in `tests/submitPlanGuard.test.js`.

## [42.3.0] - 2026-06-04

Coding-capability **Tier 2** from the audit — the structural items that most raise multi-step build quality. New tests in `tests/codingTier2.test.js`; suite now 67. Verified live in the running app (new tools registered; `fetch_url` strips HTML and is netGuard-blocked for internal hosts).

### Added — plan can now adapt mid-build
- **`add_steps` tool.** The agent appends new steps to the running plan when it discovers unplanned work (a missing config, migration, refactor); they appear in the plan panel and execute after the current ones — no re-approval (`planStore.addSteps`, IPC `plan-add-steps`).
- **Retry-then-skip on `mark_step_blocked`.** A blocked step first gets one chance to try a different approach to the *same* step instead of stranding its dependents; only then does it skip. Harness auto-blocks (stall/loop/edit-fail) still skip immediately.

### Added — new capabilities (toward production-agent parity)
- **`fetch_url` tool.** Fetch a docs/API page and get its readable text (HTML stripped, ~8 KB cap), routed through `lib/netGuard.js` (metadata/link-local/ULA blocked). Lets the model read real documentation instead of guessing from a search snippet. Available in planning and execution.
- **Background-process control.** `read_process_log` now reports `{ running, exitCode }`; new `list_processes` and `stop_process` tools; foreground `run_shell_command` gets a 5-min timeout so a forgotten long-runner fails fast instead of hanging the turn. Enables start-server → poll → curl → kill.

### Changed — verification & robustness
- **Per-step syntax gate.** Every step must now pass a fast per-file syntax check before `mark_step_done` (the full test/lint suite still runs only on the final step), so broken code is caught immediately instead of piling up to the end.
- **Unified-diff applier fails loudly.** A patch whose context/delete line doesn't match now returns a clear error and the model re-reads — previously it consumed to end-of-file, silently corrupting the file while reporting success.
- **Reading isn't a stall.** Read-only investigation (read/grep/glob/list/repo-map/fetch) no longer counts toward the "no progress" ceiling, so the agent can study several files before editing without getting its step killed.
- **Read files stay in context.** A file the model `read_file`s during a step is auto-added to that step's context (capped), so the dependency it just read doesn't fall out next turn.
- **Embeddings fallback.** When Ollama is unreachable, vector memory falls back to the configured LLM's OpenAI-compatible `/v1/embeddings`, so LM-Studio-only setups get working memory instead of silent failure.

## [42.2.0] - 2026-06-04

Fixed the **UI freeze while the agent is working** — root-caused to two synchronous hot paths (regression tests in `tests/perfFreeze.test.js`; suite now 59). Measured in the running app: streaming a 111 KB buffer went from **~3,700 ms of blocked UI thread to ~0 ms**.

### Fixed
- **Per-token re-render froze the renderer (primary cause).** `streamCompletion` calls `onDelta(fullContent)` on every streamed token, and the agent UI re-ran `markedParse` (full markdown + `highlight.js`) over the entire growing buffer and rebuilt the DOM each time — O(n²), worst with **small models**, which stream tool calls as plain text so a large `write_file` body balloons the buffer. Streaming now uses a **coalescing throttle** (`lib/renderThrottle.js`, ~10 fps) with a **cheap plain-text preview** (capped tail, no markdown/highlight per token); the full formatted result still renders once when the turn ends. The UI thread stays responsive throughout.
- **Repo map rebuilt synchronously every turn (secondary cause).** `buildRepoMap` did a synchronous whole-tree walk + 25 file reads in the main process on every execution turn, briefly freezing the whole app each turn. It's now **cached** (keyed by project root + boost terms, 10 s TTL) and **invalidated on file writes/edits/deletes**, so within a step the walk runs once instead of every turn.

Coding-capability **Tier 1** from the audit (`docs/CODING_CAPABILITY_AUDIT.md`) — the changes that most move Build Mode toward production-grade reliability on a small local model. New regression tests in `tests/codingTier1.test.js`; the suite is now 54.

### Fixed — the model no longer edits blind (`contextBuilder.js`)
- **Line numbers on every injected file** so the model can locate code precisely and build accurate `edit_file` find-blocks (the prompt tells it not to copy the `N⇥` prefix into edits).
- **No more silent middle-of-file truncation.** Oversized files show a contiguous numbered head plus an explicit `[lines X–Y omitted — use read_file…]` notice, instead of head+tail (which dropped the edited region while looking complete).
- **Honest token budget.** Estimate tightened from 3.5→2.5 chars/token (code tokenizes denser), exact-string accounting (was undercounting), and a hard fit-check that trims from the end until the prompt fits `num_ctx` but **never** drops message 0 (the plan digest). Stops the server silently front-truncating the protected digest.

### Fixed — "verified" is no longer a false signal (`lib/verificationHarness.js`, `main.js`)
- **Per-language syntax checks**, gated on the checker being installed (a missing tool is a *skip*, not a pass): Python (`py_compile`), TypeScript (`tsc`, syntax-error-only to avoid false module-resolution failures), Go (`gofmt -e`), Ruby (`ruby -c`), PHP (`php -l`), plus the existing JS/JSON.
- **Honest unverified state.** When nothing real could be checked (no test/lint command and an unsupported/uncheckable language), the step is reported **`[UNVERIFIED]`** and **not** stamped `[verified]` — it's still allowed through (can't gate on an impossible check), but it never claims verification it didn't do.

### Fixed — edits don't silently corrupt on Windows (`editEngine.js`, `lib/editFormats.js`)
- **CRLF + BOM preserved.** Edits normalize line endings/BOM for matching (so an LF find-block matches a CRLF file) and restore the file's original EOL/BOM on write — previously every tolerant edit silently rewrote CRLF→LF.
- **Tolerant match window scales to the find block**, so a find of more than 40 lines can match (was a hard 40-line cap).

### Fixed — agent loop & tools (`agentLoop.js`)
- **No more silently-dropped tool calls.** The per-turn cap is raised 4→8 and, if the model emitted more, it's told exactly how many didn't run (prevents state drift where the model believes an un-executed write happened).
- **Empty-`write_file` guard** rejects a mis-keyed argument that would write an empty file over real content (data loss).
- **Shell-aware.** The system prompt and `run_shell_command` description state the real shell (PowerShell on Windows, bash elsewhere); the bash-only `sudo` rewrite no longer runs on Windows.
- **Coding doctrine prompt.** Replaced the "fire a tool every turn" wall with real guidance: read before edit, prefer small targeted diffs, complete code (no placeholders), match style, run/verify before `mark_step_done`.

### Fixed — memory (`memory.js`)
- **Relevance floor** on vector retrieval (default 0.35, `XK_MEM_MIN_SIM`) so low-similarity snippets aren't injected as authoritative "facts".

## [42.0.0] - 2026-06-04

A **plugin system** on the level of leading coding agents': third-party folders that extend the agent with **tools**, **slash commands**, and **lifecycle hooks** — without editing core files. Plugins are trusted local code loaded in the main process, installable from a Git/URL, and declare the host capabilities they need so you consent before enabling. New engines are unit-tested (`tests/pluginSystem.test.js`); the suite is now 43 tests. Full design in `docs/superpowers/specs/2026-06-04-plugin-system-design.md`; authoring guide in `docs/PLUGINS.md`.

### Added
- **Plugin bundle format** (Approach A — industry-standard bundle style): a plugin is a folder with a `plugin.json` manifest plus convention subfolders `tools/`, `commands/`, `hooks/` (one contribution per file; auto-discovered, or listed explicitly via `contributes`). See `examples/plugins/hello` for a working tool + command + hook.
- **`lib/pluginManager.js`**: discovers/validates/loads plugins under `<userData>/plugins/`, holds the registry, persists enable + granted-capability state (`plugins.json`), routes tool/command/hook invocations, and **quarantines** a broken plugin (bad manifest, throwing module) so one bad plugin never breaks startup or the agent.
- **`lib/pluginHost.js`**: the capability-gated `host` facade handed to plugin code — `fs` (project-sandboxed), `shell`, `net` (netGuard-filtered), `memory`, `ui`, `log`. A capability you didn't declare is simply absent from `host`.
- **`lib/pluginInstaller.js`**: install from a Git/URL — host block-check via netGuard, then `git clone --depth 1` (or a GitHub-tarball download + system `tar` fallback) into a traversal-safe staging dir, manifest validation, then move into `plugins/<id>`.
- **Capability consent**: enabling a plugin shows the capabilities it requests and asks you to confirm; the host enforces only-granted caps at call time. (Honest boundary: plugins are trusted code — capabilities are transparency + defence-in-depth for honest plugins, **not** a sandbox against hostile code.)
- **Tools merge at runtime**: enabled plugin tool schemas are merged into the Build-Mode execution `tools:` array (`agentLoop.loadPluginContext` → `ctx.pluginTools`); a single generic `plugin-invoke-tool` IPC channel routes calls (no per-tool wiring). Plugin tool names are also recognised by the small-model text tool-call fallback. A tool name that collides with a core tool (or another enabled plugin) disables the offending plugin and flags it in the UI.
- **Lifecycle hooks**: `beforeToolCall`, `afterToolCall`, `onPlanApproved`, `onPlanDone`, `onMessageSend`. A `beforeToolCall` hook may veto a tool call (becomes a synthetic tool result); hook failures are logged and swallowed so a broken hook can't wedge the agent.
- **Slash commands**: typing `/<name> args` in the input expands to a plugin command's prompt template (`{{args}}`) or handler output.
- **Plugins UI** (sidebar 🧩 PLUGINS, desktop only — hidden in web mode): install-from-URL, per-plugin enable/disable with capability-consent dialog, uninstall, and surfaced `host.ui.notify` messages.
- **`lib/netGuard.js`**: new `validatePublicFetchTarget` — allows public http(s) hosts (for plugin `net` + installer downloads) while still blocking cloud-metadata / link-local / ULA hosts. Unit-tested.

## [41.3.0] - 2026-06-02

Build Mode (the durable coding agent) reliability + pro-level coding pass. No UI/markup
changes — all fixes are in the engine logic (`agentLoop.js`, `contextBuilder.js`,
`editEngine`/`editFormats`, `verificationHarness`, `planStore`, `main.js`) and renderer
wiring. A regression suite was added (`tests/agent-loop.test.js`); the full suite is now 27 tests.

### Fixed
- **Read-only / verify steps could never complete**: `run_verify` replaced the in-memory plan with the on-disk copy and wiped the per-step activity counter, so the following `mark_step_done` falsely tripped the "you haven't done any work" guard rail and the step never advanced. The activity counter is now preserved across every disk/verify sync (one shared helper, used in all three sync points).
- **Multi-step builds silently stalled**: the execution turn budget was the chat "Thinking Steps" slider (default 20) and counted every model turn, so any plan larger than a few steps ran out of turns and froze on the current step with no message. The budget now scales to the plan size (per-step allowance, the slider acts as a floor), and the agent posts a clear "reached the turn budget — paused, use Resume" notice instead of freezing.
- **`apply_edits` (batch edits) weren't tracked**: files changed via a batch edit weren't recorded on the plan, so they dropped out of context and change tracking. They're now recorded (filesTouched + ledger) and persisted like `edit_file`/`apply_patch`, on both the renderer and main-process sides.
- **BUILD MODE toggle could strand a run**: toggling build mode off mid-task hid the approve/revert controls (they live inside the build-mode panel). The toggle is now locked while a task is planning/approving/executing/under review.
- **Resuming an unapproved plan did nothing**: a resumed plan still `awaiting_approval` now runs the approval gate first instead of entering the execution loop (which only runs while `executing`) and silently returning.
- **BUILD MODE silently degraded to chat** if the plan engine failed to load; it now reports the failure instead of quietly answering as plain chat.
- **Stale agent context leak**: the per-run agent context is now cleared after a fresh build task (previously only the resume path cleaned up).

### Improved (pro-level coding)
- **No more blind edits**: a file the agent is actively editing is now shown in full when it fits the context budget, instead of being head/tail-truncated with the middle elided. The file section also gets a larger share of the prompt.
- **More reliable edits**: whitespace-tolerant search/replace now refuses ambiguous matches (instead of silently editing the first, possibly wrong, location), and unified-diff patches use the hunk's line number to anchor a repeated context/target line to the intended occurrence.
- **A real verification gate by default**: when a project has no test/lint command, verification now syntax-checks the files the step touched (JS via `node --check`, JSON via parse), so a step can't be marked complete with broken syntax.
- **Errors no longer truncated away**: long tool output (e.g. a failing test run) now preserves its tail, so the failing assertion / stack trace at the end survives.
- **Deeper working memory**: the agent retains more recent turns for continuity within a step.
- **Fewer false "infinite loop" stalls**: a single deliberate repeat of a tool call (e.g. re-running tests to recheck) is allowed rather than immediately flagged.
- **Per-step git checkpoints**: a commit is now made after each completed step (not only at the very end), so progress is recoverable mid-build.
- **Clear mode precedence**: BUILD MODE is now mutually exclusive with the Netrunner / Offline-Browser / Agent toggles, preventing those prompt-rewriting modes from leaking into a build goal.

## [41.2.1] - 2026-06-01

### Fixed
- **Massive Artifact Bloat**: Identified and resolved an issue where old `.AppImage` and `.deb` binaries from v40.7.0 were left in the project root directory. Electron-builder was recursively bundling these old 3GB+ artifacts into every new build. The workspace has been cleaned up, reducing the final application size drastically.

## [41.2.0] - 2026-06-01

### Fixed
- **Planner Render Stalls**: Resolved an issue where the agent completion of tasks would not properly trigger a DOM refresh in the sidebar, causing the UI to perpetually display Step 1. The planner now forcibly triggers an onStepAdvance UI rendering cycle every time the execution state synchronizes with the disk.
- **Explicit Task Completion**: The agent now posts a highly visible completion message in the chat feed (All Plan Steps Completed!) when it has finished all tasks in the planner, ensuring you know exactly when the full build is done.

## [41.1.0] - 2026-06-01

### Fixed
- **Planner Visual UI Desync Fix**: Resolved a critical state corruption issue inside `agentLoop.js` that caused the planner UI to visually freeze on Step 1 while the agent silently executed future steps. The agent-verification logic was incorrectly utilizing `Object.assign` without properly re-fetching array references, causing older array elements to be updated instead of the active tracking plan array. The planner UI will now reliably show the exact active step as it completes.

## [40.9.1] - 2026-06-01

### Fixed
- **Agent Progression Stall**: Fixed a critical execution loop bug where the frontend step activityCount was being wiped out by the backend plan sync at the end of every turn. This caused the agent to fail the mark_step_done guardrail repeatedly, preventing it from advancing past Phase 1 and eventually stalling out.
- **Defensive Step ID Handling**: Added fallback logic to prevent the planner from incorrectly reporting [BLOCKED step null] if an execution step is orphaned.

## [40.9.0] - 2026-06-01

### Fixed
- **Planner Sidebar Sync Bug**: Fixed a critical bug in planStore.js where approving a plan would incorrectly mark both step 1 and step 2 as active, causing the agent to skip the first step and the sidebar UI to permanently show multiple active tasks. The state is now cleanly synchronized, and the active task indicator accurately follows the agent progress.

## [40.8.0] - 2026-06-01

### Fixed
- **Planner Step Tracking**: Fixed a bug where the planner model would lose track of the agent's current progress during re-planning. The current plan digest is now correctly injected into the planning context, allowing the planner to see completed steps and the active focus.
- **Current Step Enforcement**: Enhanced the execution context to explicitly demand focus on the current step, reducing step jumping and repetition.

## [40.7.0] - 2026-06-01

### Fixed
- **Local Model Text Stalls**: Removed the overly-strict "GROUNDING" and "REASONING" text-prefix requirements from the Build Mode context builder. Forcing local models (via LM Studio) to output paragraphs of text *before* attempting a tool call was breaking their JSON tool-generation grammars, causing the `write_file` loop to stall endlessly with pure text responses like `<|channel>thought <channel|>`.
- **Code Completeness Rule**: Added a new strict directive demanding the agent output the *complete* file contents without using placeholders or comments like `// I'll fix this later`, which resolves the "lazy coding" issue during large logic tasks.

## [40.6.0] - 2026-06-01

### Fixed
- **Clean Application Build**: Removed unused CLI tools (`xagent-cli`, `build_deb.sh`) that caused conflicts during compilation. Generating `.deb` and `.AppImage` is now fully handled cleanly via `electron-builder`.
- **Infinite Loop Preventer (`agentLoop.js`)**: Implemented a hard signature check in the Build Mode execution loop. If the model fails a task and attempts to execute the exact same tool call sequence again, it is immediately caught and nudged.
- **Endless Exploration Loop (`agentLoop.js`)**: Re-anchored the loop progress checker so that if the model explores endlessly without writing to files or marking the step done, the step is automatically blocked.

## [40.4.0] - 2026-05-31

### Fixed
- **Hallucination Stalls Resolved (`agentLoop.js`)**: Fixed a critical bug where the agent would enter an endless hallucination loop if it failed to output a tool call during a long generation task. The system now injects a hard, authoritative prompt demanding a tool call, completely eliminating the "silent text-only" stalling bug.
- **True Live Chat Injection (`renderer.js` & `agentLoop.js`)**: In v40.3, user hints were appended to the chat history but weren't aggressively injected into the active execution timeline. Now, when you submit text while the agent is running, your hint is placed immediately before the AI's next internal generation tick, ensuring instant compliance and preventing the agent from "getting lost" when you manually push it to continue.

## [40.3.1] - 2026-05-31

### Fixed
- **UI Locking Syntax Error**: Resolved a syntax error in `renderer.js` that broke the main UI initialization loop, causing the application to fail to render the sign-in screen and preventing user authentication.

## [40.3.0] - 2026-05-31

### Added
- **Unlocked UI (`renderer.js`)**: The text input field is no longer disabled during agent plan execution or while awaiting approval.
- **Live Chat Injection**: Submitting text while the agent is actively executing a step or generating a plan no longer restarts or aborts the task. Instead, the message is seamlessly injected into the active `chatHistory` as a "User Hint" and is automatically appended to the agent's context on its very next iteration. This perfectly resolves the issue where the agent asks a question mid-task but the user was locked out from answering.

## [40.2.0] - 2026-05-31

### Added
- **Conversation Continuity**: preserves chat history and injects recent context into both Planning and Execution phases. No more "ignoring" follow-up instructions when entering Build Mode.
- **Grounding Mandate**: new system-level directives force the agent to verify file states and list required information before taking action.
- **Reasoning-First Execution**: the agent must now state its reasoning before every tool call, significantly reducing hallucinations and improving task transparency.
- **Mandatory Action Guard**: prevents the agent from stalling or outputting excessive conversational filler without taking functional steps.
- **Improved Remote State**: better synchronization of history and session state when using the agent via the Remote WebUI.

## [40.1.0] - 2026-05-30

### Added
- **Here I am Button**: Added a dedicated "📍 Here I am" button to the Build Mode UI allowing users to manually select and set the agent's active workspace directory.

### Fixed
- **Verification Loop Lock**: Upgraded loop-handling to aggressively prompt the model to utilize the `mark_step_done` tool when it attempts to stall or endlessly confirm completion via natural language.

## [39.9.0] - 2026-05-30

### Fixed
- **Build Mode Parity**: Synchronized Build Mode tools (`PLAN_TOOLS`) with standard agent tools (`AGENT_TOOLS`). Added missing functions like `provide_file_download_link`, `send_input`, and unified naming/descriptions for `write_file`, `run_shell_command`, and `list_directory`.
- **System Prompts**: Updated system prompts to correctly reflect version 39.9 and the full list of available tools in Build Mode.

## [39.7.0] - 2026-05-29

### Fixed
- **Build Mode Path Sandbox**: Relaxed the strict `projectRoot` path traversal sandbox. The agent can now successfully write, edit, and read from explicit absolute paths (e.g., `/home/user/Documents/gametime/`) provided by the user, while still strictly blocking malicious relative escapes (e.g., `../../etc/passwd`).

## [39.6.0] - 2026-05-29

### Fixed
- **Build Mode File Mutators**: Handled edge cases where AI agents generated tool calls using alternative JSON keys (like `file`, `path`, `text`, `code`) instead of strict schema parameters (`filepath`, `content`), which prevented file saving and editing during heavy tasks like project scaffolding.

## [39.5.0] - 2026-05-29

### Added
- Released as a consolidated stable version including all features from v50.1.0.
- Enhanced AppImage and .deb packaging.

## [50.1.0] - 2026-05-28

### Fixed — Pro-level reliability audit (esp. small models like Gemma 3n E4B)
- **`apply_patch` data loss (`lib/editFormats.js`)**: `applyUnifiedDiff` discarded every
  line *before* the first matched hunk line, silently corrupting files. Now preserves
  surrounding content and lands leading insertions at their anchor. Regression-tested.
- **Text-based tool-call fallback (`agentLoop.js`)**: small local models (Gemma 3n E4B,
  etc.) often emit tool calls as text/JSON instead of OpenAI-native `tool_calls`, which
  previously stalled the agent loop. Added a tolerant `extractToolCallsFromText`
  (handles `<tool_call>` tags, fenced ```json blocks, `parameters`/`arguments` keys,
  arrays, `tool_calls` wrappers) that only accepts real tool names so prose can't misfire.
- **Iterative planning (`agentLoop.runPlanningPhase`)**: the planner was single-shot —
  if the model ran a discovery tool (grep/read/repo-map) before `submit_plan`, the task
  aborted as `planning_failed`. It now loops, feeding tool results back, until
  `submit_plan` or a turn cap.
- **Orphaned tool messages (`contextBuilder.js`)**: budget trimming / `slice(-N)` of
  recent turns could produce a message array starting with a `role:'tool'` message that
  has no parent `tool_calls`, which strict OpenAI-compatible servers reject (HTTP 400).
  Added `sanitizeTurns` to drop orphaned tool results.
- **Verification cascade (`agentLoop.js`)**: `verifyPolicy: 'block'` ran the full
  lint/test suite before *every* `mark_step_done` and after *every* mutation, so
  intermediate multi-step work (legitimately red) blocked → 3 consecutive blocks failed
  the plan. Verification now hard-gates only the **final** step (or `verifyPolicy:
  'strict'`); mid-build failures are recorded as warnings and auto-verify is skipped to
  cut latency. The model can still call `run_verify` explicitly.
- **Web server path traversal (`main.js`)**: the static file handler did
  `path.join(__dirname, url)` with no containment, and `.js`/`.css`/`.png` paths bypass
  the auth gate — allowing unauthenticated arbitrary file reads by extension
  (`/../../secret.js`). Now decoded and contained within the app directory.
- **SSRF + arbitrary file download hardened (`lib/netGuard.js`, `main.js`,
  `standalone-server.js`)**: `/api/proxy/*` accepted any `x-target-url` (SSRF pivot into
  localhost services / cloud metadata `169.254.169.254`); it now only reaches loopback or
  the configured LLM origin, always blocks metadata/link-local, and strips
  `Authorization`/`Cookie` so the app's session token can't leak to the target.
  `set-lms-url` is validated before it feeds the allowlist. `/download_remote?file=`
  served any absolute path to an authenticated user; it's now confined (symlink-resolved)
  to the project root / app-data / downloads directories. `standalone-server.js`'s
  unauthenticated proxy is now loopback-only (override via `XK_LLM_ORIGIN`). Pure logic in
  `lib/netGuard.js`, unit-tested.
- **Tests**: `tests/durable-modules.test.js` expanded (patch correctness, search/replace
  tolerance, tool-call extraction, turn sanitization, SSRF allowlist, download path
  containment) — **14 passing**; ship-check green.

## [50.0.0] - 2026-05-28

### Added — Full-project coding agent
- **`lib/grepTool.js`**, **`lib/globTool.js`**, **`lib/repoMap.js`**, **`lib/ignoreFilter.js`**: Project search and repo map for large codebases.
- **`lib/editFormats.js`**, **`editEngine.js` v2**: Fuzzy search/replace, `apply_patch`, batch edits, 64KB write cap.
- **`lib/verificationHarness.js`**, **`lib/projectDetector.js`**: Detect test/lint commands; block `mark_step_done` until verified.
- **`lib/gitIntegration.js`**: Git init, per-step commits, undo last agent commit.
- **`lib/activeFileSet.js`**, **`lib/chatSummarizer.js`**, **`lib/planTemplates.js`**: Active file tracking, summarization, greenfield/brownfield step templates.
- **`lib/dualModelRouter.js`**: Planner vs editor model selection for build phases.
- **`agentLoop.js` v2**: Multi-tool turns (up to 4), expanded plan tools, post-mutate verify, git commit on step done.
- **`contextBuilder.js` v2**: Repo map, active files, verify hints in each turn.
- **Plan schema v2**: `testCmd`, `lintCmd`, `verifyPolicy`, `activeFiles`, `verifiedAt` per step.
- **UI**: Planner/editor model selects, plan test/lint fields, git log + undo in review.
- **Tests**: `tests/durable-modules.test.js` via `npm test`.
- **Ship check**: `npm run ship-check` (greenfield/brownfield/ledger scenarios).
- **CLI**: `cli-build.js` headless plan creation; `xagent-cli` reuses root `tools.js`.

### Changed
- **Version** 50.0.0; dependencies `fast-glob`, `ignore`, `diff-match-patch`.
- **`tools.js`**: Aligned with v50 discovery tools; fixed `memory_search` result parsing.

## [40.0.0] - 2026-05-28

### Added — Durable Memory & Planning System
- **`planStore.js`**: Plan object persisted per project (`<userData>/plans/`). Harness-owned step status, results, `filesLedger`, decisions, scratchpad.
- **`contextBuilder.js`**: Rebuilds model messages each turn from plan digest + live file excerpts + recent turns + vector memory (within `ctxSlider` budget).
- **`changeLedger.js`**: Snapshot before write/edit/delete; unified diff; `revertAll()` restores originals and deletes newly created files.
- **`editEngine.js`**: Exact → whitespace-tolerant `edit_file`; structured errors with closest-match hints; integrates with ledger.
- **`projectContext.js`**: Implicit project root (from user text or first file op); path sandbox; `list_project` tree; PowerShell on Windows / bash on Linux.
- **`agentLoop.js`**: Plan → user approval → step-by-step execution → review. Tools: `submit_plan`, `mark_step_done`, `mark_step_blocked`, `edit_file`, `run_command`, etc.
- **Build Mode toggle**: Coding workflow separated from chat. Plan panel, context slider, step tracker, diff/review UI shown only in Build Mode.
- **Agent toggle restored to chat tools**: AGENT (SYS-ACCESS) enables shell/file tools in the conversational loop without triggering plan approval.
- **Context Window slider**: Restored for Build Mode (2048–131072); drives `contextBuilder` token budgeting.
- **Resume banner**: Incomplete plans reload on startup; resume enables Build Mode automatically.
- **Project memory**: Compact task summary written to vector store at build completion (`type: project_memory`).
- **IPC**: `plan-*`, `ledger-*`, `edit-apply`, `project-*`, `agent-list-project` wired through `preload.js` and `main.js`.
- **`test-durable-modules.js`**: Smoke test for ledger, edit engine, and plan state machine.

### Changed
- **Memory model inverted**: Chat transcript is no longer authoritative during builds; Plan JSON on disk is. Fixes mid-task forgetting on long jobs.
- **Line-ranged `read_file`**: Optional `start`/`end` line parameters for large files.
- **`write_file` size cap** (~8KB in build path); large changes go through `edit_file`.
- **Generation cutoff**: No aggressive re-prune on context limit; user-visible message instead of emergency transcript wipe (build path).

### Removed
- **RESOURCE SAVER** toggle and Task Isolation flush (obsolete with durable plan memory).
- **`pruneChatHistory` aggressive logic** (`isDeepLoop`, hardcoded 131072 cap, char-budget nuking) — stub passthrough for chat path only.
- **`memory_purge`** tool from agent schema.
- **Auto-fallback plan**: Casual messages no longer forced into a 3-step plan when the model skips `submit_plan`.

### Fixed
- **`open-external-url`**: Added missing `shell` import from Electron.
- **Build vs chat routing**: "Hello" with Agent on no longer enters plan approval (requires Build Mode).

## [39.4.0] - 2026-05-28

### Removed
- **xagent-cli**: Completely removed the standalone CLI application (`xagent-cli`) and its CLI build scripts to focus entirely on the Electron desktop UI.

## [39.3.0] - 2026-05-28

### Changed
- **Context Slider Removal** *(restored in v40 for Build Mode)*: Removed from general UI in v39.3; v40 adds it back under Build Mode for `contextBuilder` token budgeting.
- **Robust Remote Downloads**: Fixed a UI crash related to binary file downloads by routing download links through Electron's native `shell` module instead of internal DOM navigation.

## [39.2.0] - 2026-05-27

### Changed
- **Ollama UI Removal**: Ollama has been removed as a user-selectable model provider in the sidebar to simplify the interface and focus on LM Studio / OpenAI compatible backends.
- **Persistent Embedding Backend**: Ollama remains the core engine for persistent vector memory and embeddings (all-minilm), ensuring backward compatibility with existing knowledge bases.
- **Forced Uplink Mode**: The application now defaults to LM Studio/OpenAI compatible mode for the primary chat interface.

## [39.1.0] - 2026-05-20

### Added
- **Dynamic System Clock**: The agent now automatically injects the current host date and time into the system prompt right before generation for both LM Studio (OpenAI format) and Ollama payloads. The AI will never assume or hallucinate the current date again.

## [38.2.0] - 2026-05-15

### Added
- **Cloudflare-Ready Download Links**: The agent can now securely serve files directly from the host machine to any remote device via a new `provide_file_download_link` tool.
- **Token-Authenticated Downloads**: Hyperlinks generated by the agent dynamically inherit the active user's session token, ensuring unauthorized access to the `/download_remote` endpoint is strictly blocked.
- **Unified Tool Schema**: Stabilized tool dispatch logic across `renderer.js` and `tools.js` to ensure the AI always has full context of available commands.
- **45% Generation Headroom**: The Context Guard now strictly limits prompt context to 55% of your slider size during loops, guaranteeing a massive 45% (thousands of tokens) dedicated purely to outputting huge code files.
- **In-Flight Wipes**: Intermediate tool outputs are now continuously wiped while the agent is running multi-step tasks, keeping the payload incredibly lean without dropping the original task instruction.
- **Auto-Recovery**: If a massive generation does hit the hard limit, the agent no longer crashes. It forces an emergency memory wipe and prompts the AI to try a chunked strategy.

## [38.1.0] - 2026-05-10

### Added
- **Task-Aware Pruning**: The agent now identifies your original task and formal `task_begin` plans, ensuring they are NEVER pruned even when context is tight.
- **Automatic Resource Guard**: When system RAM or process memory is low, the agent automatically triggers "Task Isolation" mode, flushing intermediate bloat while keeping your goals intact.
- **LM Studio Optimization**: Mathematically bound context payloads prevent "Rolling Window" thrashing and guardrail errors in LM Studio.

## [38.0.0] - 2026-05-05

### Changed
- **Ollama Stability Fixes**: Resolved issues where the agent would "hang" or "think" indefinitely when using Ollama models for complex tasks. This was caused by a missing loop continuation instruction after executing tools, which has now been fixed.
- **Improved Streaming Parser**: The Ollama stream handler now more reliably captures tool calls and content deltas, even with high-latency or high-pressure generation.
- **Resource Defaults**: RESOURCE SAVER is now toggled OFF by default. This ensures the model retains more conversational context for better reasoning, unless the user explicitly chooses to optimize for low VRAM.
- **Enhanced System Directives**: Refined the core system prompt (v38) to be more authoritative with file system and system-level tasks, ensuring the model uses tools immediately without hesitation.

## [37.9.1] - 2026-05-01

### Fixed
- **High-Contrast Chat Bubbles**: Eliminated visual halation (faint text) by redesigning chat bubbles to feature pure black text on light backgrounds, ensuring maximum readability without sacrificing the app's dark theme.
- **History & Agent Logic Restoration**: Fixed the silent agent bug (where the agent ignored prompts due to payload cloning errors) and restored the automated legacy history migration script to safely recover previously wiped chat logs.

## [37.9.0] - 2026-04-28

### Changed
- **Visual Overhaul**: Boosted the contrast, brightness, and font weight of all text in the chat interface. Solved the issue where default text, labels, and system messages appeared faded or "greyed out" against the dark background.

## [37.8] - 2026-04-25

### Fixed
- **Responsive Offline Browsing**: Fixed an issue in the Offline Web Browser where AI-generated websites lacked mobile-responsiveness constraints. The shadow DOM now forcibly injects responsive baseline CSS (like `word-wrap: break-word` and `max-width: 100%`) into all generated pages.

## [37.7] - 2026-04-20

### Fixed
- **Ollama Offline Browser Compatibility**: Ensures full compatibility with the Offline Web Browser mode when using standard Ollama models. Fixes a bug where Ollama's stream payload variations resulted in a blank white Shadow DOM.

## [37.6] - 2026-04-15

### Added
- **Offline Web Browser Mode**: Allows the agent to act as an offline web server. It dynamically generates a complete, professional HTML5/CSS webpage to present information, rendered directly in the chat via a secure Shadow DOM.

## [37.5] - 2026-04-10

### Added
- **Task Isolation (Ultra-Aggressive Pruning)**: When "Resource Saver" is enabled, the agent automatically and fully flushes its internal chat memory every time you send a new request (keeping only your new instruction and the system prompt).

## [37.4] - 2026-04-05

### Added
- **Hallucination Loop Protection**: Eliminates the "endless partial generation" bug. The agent actively monitors the stream's `finish_reason` and halts the autonomous loop if it detects an early cutoff. Uses deep-cache batch pruning to keep prompt evaluation speeds fast.

## [37.3] - 2026-04-01

### Added
- **LM Studio Context Guard**: Fixes extreme task times in LM Studio Mode caused by context window thrashing. Mathematically binds the chat history payload to 75% of your chosen Context Size.

## [37.2] - 2026-03-25

### Added
- **Active Generation Locks**: Fixes mid-task timeouts by completely locking models in VRAM (`keep_alive: -1`) while the agent is executing a multi-turn autonomous loop.

## [37.0] - 2026-03-20

### Added
- **Heavy Context Processing**: Resolves "Model timed out" errors after VRAM purges by implementing a dynamic Time-To-First-Token (TTFT) handler, allowing large models up to 15 minutes to reload.

## [36.4] - 2026-03-15

### Added
- **Predictive Resource Guard**: Multi-layered memory management system including Real-time Resource Monitoring, Adaptive Sliding Window, Visual Health Status, Dynamic History Pruning, and Autonomous Memory Purge.

## [36.2] - 2026-03-10

### Added
- **Secure Authentication**: Built-in security layer including Multi-User Support, Role-Based Access, and Encrypted Credentials (bcrypt).

## [36.0] - 2026-03-05

### Added
- **Asynchronous Background Tasks**: Natively execute, monitor, and interact with heavy system workloads via background processing, log tailing (`read_process_log`), and interactive input (`send_input`).

## [35.0] - 2026-02-28

### Added
- **Cloudflare Remote Access**: Automatic tunnels via `cloudflared` to generate secure, ephemeral URLs, plus a standalone headless server option.

## [34.0] - 2026-02-20

### Added
- **Autonomous "Plan-Execute-Verify" Workflow**: Sophisticated multi-turn autonomous loop using `task_begin` and `task_complete` for complex system tasks and research.

## [31.3] - 2026-02-10

### Added
- **Neuro-Core (Intelligent Persistent Memory)**: Low-VRAM optimization forcing `all-minilm` to run on CPU, zero-swap performance, and strict fact retention using `save_new_user_fact_only`.