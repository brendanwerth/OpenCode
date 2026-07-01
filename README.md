# OpenCode

A local AI coding agent for Windows — a Claude Code / Codex–style tool that you point at your own API keys. Bring **Anthropic**, **OpenAI**, or **OpenRouter** (or all three) and let it read, edit, and run code in a project folder until the task is done.

It aims to be *better* than a terminal coding agent by doing things a GUI can that a TUI can't:

## What makes it better than the terminal

- **🧠 Smart multi-model routing** — assign a strong **planner** model and a cheap **worker** model. OpenCode auto-routes per step: the worker handles read-only exploration (reads, greps, searches), the planner handles writes, decisions, and error recovery. Long tasks get dramatically cheaper without losing quality where it matters.
- **📋 Plan-first mode** — the agent drafts an ordered, **editable** plan and waits for your approval before it touches any code. Catch a wrong approach before tokens are spent. Add, edit, or delete steps inline, then Approve & Run.
- **📝 Visual diff review** — every file change is shown as a colored, line-numbered diff. **Accept or reject** each change before it's written to disk. No more scrolling a terminal wall of text.
- **⏪ Checkpoints & rewind** — every agent step that edits files is journaled. A timeline in the left rail lets you **rewind** to any prior point with one click — files are restored and the conversation truncated. Instant, visual time-travel.
- **🔌 Bring any provider** — native Anthropic Messages API, native OpenAI Chat Completions, and OpenRouter (with live model browser + OAuth). Mix providers between planner and worker.

## Core agent features

- **Agentic loop** — autonomously chains `read → plan → edit → run → verify` until complete.
- **Real tools** — `read_file`, `write_file`, `edit_file`, `list_dir`, `grep`, `run_command`, plus `web_search` (DuckDuckGo, no key) and `fetch_url`.
- **Workspace sandbox** — pick a project folder; all file operations are confined to it (no path-traversal escape).
- **Cost & token tracking** — live per-task spend (exact for OpenRouter, estimated for Anthropic/OpenAI from token counts).
- **Multiple tasks** — separate, persisted conversations with their own timelines.

## Run it (development)

```bash
npm install
npm start
```

1. Click **Open Project Folder** (left rail) and choose the codebase to work on.
2. In the right rail, paste at least one API key (**Anthropic**, **OpenAI**, or **OpenRouter** — OAuth available for OpenRouter).
3. Pick a **Primary (planner) model**. Optionally turn on **Smart routing** and pick a cheap **worker** model.
4. Optionally turn on **Plan-first mode**.
5. Describe a task in the composer and press **Ctrl + Enter**.

## Build a Windows installer

```bash
npm run dist
```

Produces an NSIS installer (`.exe`) under `dist/`.

## How it works

- `electron/main.js` — privileged main process: window, filesystem + shell IPC (sandboxed to the workspace), checkpoint snapshot/delete primitives, and a **streaming LLM proxy** so every provider streams uniformly with no browser-CORS limits.
- `electron/preload.js` — exposes a minimal `window.opencode` bridge to the UI.
- `src/index.html` — the interface (chat, model pickers, timeline, diff/plan cards).
- `src/app.js` — provider adapters (OpenAI/OpenRouter + Anthropic), the streaming agent loop, smart routing, plan-first mode, visual diff review, and checkpoints.

## Notes

- **Keys are local.** Stored in `localStorage` and sent only to the provider you select (via the main-process proxy).
- **Tool-calling** requires a model that supports it (most modern Claude, GPT, Gemini, Qwen, Llama-3.1+ models do).
- **Checkpoints track file edits** made through `write_file`/`edit_file`. Side effects of arbitrary `run_command`s (e.g. a script that rewrites many files) are not journaled, so rewind covers the agent's own edits, not every possible shell mutation.
- **Curated model prices** for Anthropic/OpenAI are approximate (shown with `~`); OpenRouter pricing is exact and live. You can type any custom model id into the search box.
