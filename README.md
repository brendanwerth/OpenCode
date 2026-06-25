# CodeNexus

A local AI coding agent for Windows — a Claude Code / Codex–style tool that runs entirely on **OpenRouter**, so you can use cheaper/alternative models instead of burning Claude tokens.

CodeNexus reads and edits files in a project folder, runs terminal commands, browses the web, and loops on tool calls until your task is done — all inside an Electron desktop app.

## Features

- **Agentic loop** — the model autonomously chains `read → edit → run → verify` until the task is complete.
- **Real tools** — `read_file`, `write_file`, `edit_file`, `list_dir`, `grep`, `run_command`.
- **Web browsing** — `web_search` (DuckDuckGo, no API key) and `fetch_url` so the agent can look up docs and current info.
- **Workspace sandbox** — pick a project folder; all file operations are confined to it (no path-traversal escape).
- **Approvals** — asks before writing files or running commands, with a one-click "don't ask again" (YOLO) mode.
- **Cost & token tracking** — live per-task spend reported by OpenRouter, shown in the header and sidebar.
- **OpenRouter model browser** — search hundreds of models with live pricing; OAuth or API-key login.
- **Multiple tasks** — separate, persisted conversations in the sidebar.

## Run it (development)

```bash
npm install
npm start
```

1. Click **Open Project Folder** (left rail) and choose the codebase you want to work on.
2. In the right rail, connect **OpenRouter** (OAuth or paste an `sk-or-...` key) and pick a model.
   - Tool-calling requires a model that supports it (most Claude, GPT, Gemini, Qwen, Llama-3.1+ models do).
3. Describe a task in the composer and press **Ctrl + Enter**.

## Build a Windows installer

```bash
npm run dist
```

Produces an NSIS installer (`.exe`) under `dist/`.

## How it works

- `electron/main.js` — privileged main process: window, filesystem, and shell IPC handlers (sandboxed to the workspace).
- `electron/preload.js` — exposes a minimal `window.nexus` bridge to the UI.
- `src/index.html` — the interface.
- `src/app.js` — chat UI, OpenRouter model browser, tool definitions, and the streaming agent loop.

## Notes

- **OpenRouter only.** All inference goes through OpenRouter — pick any model it offers (including Claude, GPT, Gemini, Qwen, Llama) from the in-app browser. Tool-calling requires a model that supports it (most modern ones do).
- **Web tools** need no API key — search uses DuckDuckGo's HTML endpoint and fetch pulls readable page text in the main process (so CORS doesn't apply).
- Your API key and conversations are stored locally in the app's `localStorage`.
