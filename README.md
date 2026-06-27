<p align="center">
  <img src="icon.png" alt="Agent Smith" width="96" height="96" />
</p>

<h1 align="center">Agent Smith</h1>

<p align="center">
  <strong>Local-first AI coding agent built for small models.</strong><br>
  Run Gemma, Qwen, and other 7B–35B models through LM Studio — with real tools, real edits, and a safety net you can undo.
</p>

<p align="center">
  <a href="https://github.com/GhostWrk/Agent-Smith/releases/tag/v46.13.1"><img src="https://img.shields.io/badge/version-46.13.1-00c853?style=flat-square" alt="Version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License" /></a>
  <img src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey?style=flat-square" alt="Platforms" />
  <img src="https://img.shields.io/badge/models-LM%20Studio%20(local)-8b5cf6?style=flat-square" alt="LM Studio" />
  <img src="https://img.shields.io/badge/memory-LM%20Studio%20embeddings-00c853?style=flat-square" alt="LM Studio embeddings memory" />
</p>

<p align="center">
  <a href="https://github.com/GhostWrk/Agent-Smith/releases/latest"><strong>Download Linux build</strong></a>
  &nbsp;·&nbsp;
  <a href="#quick-start">Quick start</a>
  &nbsp;·&nbsp;
  <a href="#documentation">Documentation</a>
  &nbsp;·&nbsp;
  <a href="CHANGELOG.md">Changelog</a>
</p>

---

## What is Agent Smith?

**Agent Smith** is a desktop coding assistant that turns a locally hosted language model into a capable build partner. Unlike chat-only UIs, it can **read your project, edit files, run commands, verify results, and show you exactly what changed** — all without sending your code to the cloud.

It is designed for developers who want **privacy, control, and predictable behavior** from smaller open models (7B–35B) that are fast enough to run on consumer hardware.

> Your machine. Your model. Your codebase. Agent Smith stays on your side of the wire.

---

## Why Agent Smith?

| | |
|---|---|
| **Runs fully local** | Pair with [LM Studio](https://lmstudio.ai/) — no API keys, no data leaving your machine. |
| **Built for small models** | Gemma harness, forgiving tool parsing, compact prompts, and auto-tuned runtime profiles so 7B–35B models can actually ship code. |
| **Smart persistent memory** | Local embedding-backed memory for recall across runs. Load an embedding model in LM Studio alongside your chat/code model before using memory features. |
| **Three focused modes** | Chat when you only need conversation. Agent when you need the whole machine. Code Mode when you need an autonomous build loop. |
| **Trust you can verify** | Every edit is snapshotted. Review a unified diff when a run finishes. **Revert All** restores the exact pre-run state. |
| **Plans that persist** | Non-trivial Code runs write `.agentsmith/PLAN.md` and `IMPLEMENT.md` so long tasks survive restarts. |
| **Ships with guardrails** | Completion gates, syntax checks, command/path policies, and an audit log — automation with brakes, not blind autopilot. |
| **Desktop + phone** | Electron app with a frameless UI; optional LAN or tunnel access and a QR code to open the cockpit on your phone. |
| **Extensible** | Plugin system for custom tools, hooks, and commands ([`docs/PLUGINS.md`](docs/PLUGINS.md)). |

---

## Three operating modes

Agent Smith keeps modes **strictly separated** so chat, host control, and project builds never step on each other.

| Mode | How to enable | Best for |
|------|---------------|----------|
| **Chat** | Agent and Code both off | Q&A, brainstorming, conversation — no tools |
| **Agent** | **AGENT** on | Shell, process control, whole-host file access, web search & fetch — with policy guardrails |
| **Code** | **CODE MODE** on | Autonomous build loop on your workspace — read, patch, shell, grep, verify, ledger |

**Agent** and **Code** are mutually exclusive by design.

### Code Mode — the build engine

Describe what you want built. Agent Smith plans, implements, runs tests, and grinds toward green — automatically.

- Multi-tool turns with phase gates (explore → implement → verify)
- Patch-first editing with ledger snapshots before every write
- Live activity timeline in chat so you see every tool call
- Completion gate blocks premature "done" on broken output
- **Revert All** when you want a clean slate

### Agent Mode — your local operator

When you need the model to act across your machine:

- Run shell commands and manage processes
- Read, write, and delete files anywhere on the host (catastrophic paths blocked by policy)
- Search the web and fetch pages as text (`web_search`, `fetch_url`)
- Review and undo consequential actions via the audit log

### Chat Mode — zero friction

Plain LLM streaming when you do not want tools in the loop.

---

## Download

Pre-built **Linux** installers (v46.13.1):

| Format | File | Notes |
|--------|------|-------|
| **AppImage** | [`agent-smith-46.13.1.AppImage`](https://github.com/GhostWrk/Agent-Smith/releases/download/v46.13.1/agent-smith-46.13.1.AppImage) | Portable — `chmod +x` and run |
| **Debian/Ubuntu** | [`agent-smith_46.13.1_amd64.deb`](https://github.com/GhostWrk/Agent-Smith/releases/download/v46.13.1/agent-smith_46.13.1_amd64.deb) | `sudo dpkg -i` then `sudo apt -f install` if needed |

All releases: **[github.com/GhostWrk/Agent-Smith/releases](https://github.com/GhostWrk/Agent-Smith/releases)**

For macOS and Windows, clone the repo and use the quick start below — the launcher handles platform-specific dependencies.

---

## Quick start

### 1. Load your local models in LM Studio

Open **LM Studio** and start the local server at `http://localhost:1234`.

Load both models before launching Agent Smith:

1. A chat/code model, such as Gemma or Qwen.
2. A local embedding model for memory/search.

Keep LM Studio running while Agent Smith is open. No cloud API key is required.

### 2. Launch Agent Smith

**Easiest** — works on Linux, macOS, and Windows:

```bash
# Linux / macOS
bash run.sh
```

```bat
:: Windows (or double-click run.cmd)
run.cmd
```

The launcher installs dependencies for **your** platform on first run. If you copied the project from another OS, it detects the mismatch and reinstalls automatically.

**Manual:**

```bash
npm install
npm start
```

### 3. Point it at your project

1. Set your workspace with **📍 Here I am**
2. Turn on **CODE MODE** in the sidebar
3. Describe the task — watch the timeline as tools run
4. Review the diff; hit **Revert All** if you want to roll back

**Model tip:** If LM Studio uses just-in-time loading, the model list may look empty at first. Pick your model once in the dropdown — Agent Smith remembers it.

**Memory tip:** If memory or recall says embeddings are unavailable, return to LM Studio and confirm the embedding model is loaded and the local server is still running.

---

## Feature highlights

**Intelligence & tuning**
- Runtime auto-tune — model-aware context and temperature profiles ([`docs/RUNTIME_PROFILE.md`](docs/RUNTIME_PROFILE.md))
- Gemma harness — system folding and tool JSON preamble for small-model reliability
- Smart persistent memory — local embeddings provide recall without cloud services; load the embedding model in LM Studio before using memory features
- Zero-setup cockpit — Build Mode plans then grinds to green; Hardware Guard shows live RAM/VRAM/GPU

**Safety & trust**
- Change ledger with byte-exact **Revert All**
- Agent action log — review and undo file writes and deletes
- `commandPolicy` and `pathPolicy` refuse catastrophic shell and filesystem targets

**Workflow**
- Live preview panel for web projects
- Headless `browser_verify` for HTML acceptance checks in Code Mode
- Durable `.agentsmith/` artifacts for multi-step missions
- Optional WhatsApp linking and phone QR for remote cockpit access

**Polish**
- Frameless desktop shell with custom window controls
- Official Linux desktop entry via `npm run install-desktop`
- Matrix-inspired UI with a modern card overlay

---

## Documentation

| Doc | Purpose |
|-----|---------|
| [`SMITH.md`](SMITH.md) | Product doctrine and design law |
| [`docs/CODE_MODE.md`](docs/CODE_MODE.md) | Code Mode deep dive |
| [`AGENTS.md`](AGENTS.md) | Repo map for contributors and AI assistants |
| [`PROTOCOL.md`](PROTOCOL.md) | Protocol and security detail |
| [`docs/architecture.md`](docs/architecture.md) | System layout |
| [`docs/PLUGINS.md`](docs/PLUGINS.md) | Plugin development |
| [`CHANGELOG.md`](CHANGELOG.md) | Release history |

---

## For developers

### Build from source

```bash
npm install
npm run build:renderer
npm start
```

### Linux packages

Build on Linux (electron-builder does not cross-compile cleanly from Windows):

```bash
npm install
npm run dist              # → AppImage + .deb in release/
npm run install-desktop   # optional: app-menu launcher + taskbar icon
```

### Verification

```bash
npm test
npm run ship-check
node scripts/verify-main-ipc.js
npm run build:renderer
```

### Project layout

| Path | Role |
|------|------|
| `src/code/` | Code Mode engine — turn loop, tools, completion gate |
| `src/main/` | Electron main process — services and IPC |
| `src/renderer/` | UI — chat, sidebar, timeline, mode toggles |
| `src/shared/` | Cross-process helpers — policies, channels, persona |
| `tests/` | Unit and integration tests |
| `docs/` | Architecture, harness, and mode documentation |

### Sharing across operating systems

**Do not zip `node_modules`.** Native binaries (`esbuild`, `electron`) are platform-specific. Send source only; recipients run `npm install` on their machine.

---

## License

MIT — see [`LICENSE`](LICENSE).

<p align="center">
  <sub>Agent Smith v46.13.1 · Built for local models, built for builders.</sub>
</p>