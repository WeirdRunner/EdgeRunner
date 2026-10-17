<p align="center">
  <img src="frontend/public/EdgeRunner.svg" alt="EdgeRunner" width="550" />
</p>

<p align="center">
  <strong>A coding agent and dev workspace that runs on the edge: in your browser tab, or on your own Mac.</strong>
</p>

<p align="center">
  <a href="https://weirdrunner.github.io/EdgeRunner/">Open EdgeRunner</a> ·
  <a href="#run-it-on-your-mac">Mac node</a> ·
  <a href="#how-it-works">How it works</a>
</p>

---

## What it does

- **Coding agent.** Give it a task; it reads your code, edits files (every change shown as a diff), runs commands and
  tests, fixes what fails, and summarises. Choose whether it asks before commands or edits. Every reply has
  **undo file changes**.
- **A real workspace in the browser.** Node.js 22, npm and a shell run inside the tab ([WebContainers](https://webcontainers.io)),
  with a terminal, file explorer, editor and live preview of dev servers. Files persist in the browser.
- **GitHub.** Clone a repo into the workspace, see what changed, commit & push, pull, or publish a folder as a new repo.
- **Your Mac, optionally.** Run the small EdgeRunner node and the same agent works in project folders on your Mac,
  with your real tools (git, Python, compilers). Commands run in a sandbox that can only write inside the project.
- **Free models.** Uses [OpenRouter](https://openrouter.ai) — pick any of its free, tool-capable models. Your key is
  stored encrypted in your browser and only sent to OpenRouter.

## Quick start

1. Open **https://weirdrunner.github.io/EdgeRunner/** in Chrome, Edge, Brave or Arc on a computer.
2. Get a free key at [openrouter.ai/keys](https://openrouter.ai/keys) and paste it in **⚙ Settings** (or the model picker).
3. Choose **/agent** and describe a task, e.g. *"create a Vite + React todo app and start it"*.

Free OpenRouter models have daily request limits; when you hit one, EdgeRunner says so — switch model or try later.

## Run it on your Mac

The agent can work on your own projects through the EdgeRunner node (Python 3.10+):

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -e .
edgerunner-node --add ~/code/my-project     # prints an access token; runs on http://127.0.0.1:8100
```

In EdgeRunner: **⚙ Settings → Mac node**, paste the token, then pick the project in the workspace menu next to the
model (**Browser ▾ → Mac · my-project**). `edgerunner-node --token` shows the token again.

What the node allows:

- Only requests carrying the token, and only from EdgeRunner's own pages (CORS), can use it.
- Files can only be read or written inside the project folders you added.
- On macOS, commands run under `sandbox-exec`: they can write to the project, temp folders and package caches, nothing
  else. By default the agent asks before every command on the Mac.

## Where it runs

| | Browser workspace | Mac node |
|---|---|---|
| Desktop Chrome / Edge / Brave / Arc | ✅ | ✅ |
| Safari, Firefox | chat only (no in-browser runtime yet) | ✅ |
| Phones / tablets | chat only | not yet (the node only listens on the Mac itself) |
| Languages | JavaScript / TypeScript (Node.js 22) | whatever is installed on the Mac |

## How it works

```
frontend/ (Next.js, static on GitHub Pages)
  lib/agent/agent.ts       tool-calling loop: model ⇄ tools, approvals, per-reply undo
  lib/agent/tools.ts       list/read/search/write/edit files, run commands (incl. background dev servers)
  lib/agent/workspace.ts   where tools act: the browser runtime, or a Mac project via the node
  lib/agent/openrouter.ts  streaming chat completions with native tool calls
  lib/edge/runtime.ts      WebContainer: files, shell, processes, ports, persistence in IndexedDB
  lib/edge/github.ts       GitHub via its REST API: clone, status (blob hashes, .gitignore), push, pull, publish
backend/ (FastAPI)
  app/routers/node.py      the Mac node API: project-scoped files + sandboxed commands
  app/core/auth.py         token + CORS + private-network preflight
```

GitHub sync uses the REST API because browsers can't speak git's protocol: there is no local history or branching,
just clone → change → commit & push / pull (a file changed on both sides keeps yours and saves GitHub's as `.theirs`).

The backend also contains the original llama.cpp / Kaggle GPU chat server (`kaggle/`, `deploy/`), used for
self-hosted models.

## Develop

```bash
cd frontend && npm install && npm run dev          # http://localhost:3000 (sends the isolation headers WebContainers need)
cd backend && pip install -e ".[dev]" && pytest    # backend tests
```

CI runs the backend tests, the TypeScript check and the static build on every push.

## Keyboard shortcuts

| Keys | Action |
| :--- | :--- |
| `⌘K` / `Ctrl+K` | Home |
| `⌘⇧N` / `Ctrl+Shift+N` | New session |
| `⌘B` / `Ctrl+B` | Sessions |
| `⌘M` / `Ctrl+M` | Model picker |
| `⌘,` / `Ctrl+,` | Settings |
| `⌘S` / `Ctrl+S` | Save file (editor) |
| `Esc` | Close / stop |
| `⌘/` or `?` | All shortcuts |

## License

MIT
