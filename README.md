# Droolcat Agent

> **Claude Code, with visual nodes.** Droolcat drives the Claude Code CLI
> headless and turns a coding session into a live, navigable graph instead of a
> scrolling wall of terminal text.

Droolcat is a **layer on top of the Claude Code CLI — not a fork, not an
extension.** It spawns and owns sessions (`claude -p --output-format
stream-json --verbose`, resuming with `--resume` so context carries over),
consumes the structured event stream, and renders it as a spatial **Agent
Graph**: a **continuous conversation** where each prompt appends a turn —
your message → the reads / edits / bash / subagents it runs → a result — and
the next prompt continues below it. Multiple **chats** live in the sidebar; a
second view maps the **project's code** as a file/import graph.

This repo is the **driver model**, realized as a [Tauri](https://v2.tauri.app)
desktop app: the Rust core owns the subprocess; the web canvas renders it.

---

## Architecture — the core loop

```
 claude -p (subprocess)           src-tauri/src/lib.rs        src/
 ─────────────────────            ────────────────────        ────
 stream-json on stdout  ──►  Bridge: spawn + read lines  ──►  graph.js   reducer: event → graph mutation
   {type:"assistant",…}        tee raw transcript to disk      layout()   tidy-tree auto-layout (live)
   {type:"user",…}             emit `claude-event`        ──►  canvas.js  pan/zoom render + inspector
   {type:"result",…}                                            main.js   chats, turns, prompt bar
```

| Piece | Where it lives |
| --- | --- |
| **Bridge** — spawn `claude -p` (+`--resume`), read NDJSON, tee + broadcast | [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs) |
| **Reducer** — event → graph mutation; multi-turn (`beginTurn`/`apply`) | [`src/graph.js`](src/graph.js) |
| **Auto-layout** — tidy tree for the growing turn chain | `layout()` in [`src/graph.js`](src/graph.js) |
| **Canvas** — pan/zoom, status, inspector | [`src/canvas.js`](src/canvas.js) |
| **Code Graph** — repo scan → file/import view | [`src/codegraph.js`](src/codegraph.js) + [`src-tauri/src/codegraph.rs`](src-tauri/src/codegraph.rs) |
| **Chats + prompt** — sessions, multi-turn, view switch | [`src/main.js`](src/main.js) |

The bridge emits: `claude-event` (one parsed stream-json object),
`claude-stderr`, `claude-end` (`{ ok }`).

---

## Running it

### Prerequisites

- **[Claude Code CLI](https://docs.claude.com/en/docs/claude-code)** on the
  machine (`claude --version`). The bridge auto-locates it at
  `~/.local/bin/claude[.exe]` or the npm shim, bypassing PATH.
- **Node 18+** (frontend tooling).
- **Rust** (stable) — install via [rustup](https://rustup.rs).
- **Platform toolchain for Tauri** (see
  [prerequisites](https://v2.tauri.app/start/prerequisites/)):
  - **Windows:** the *Desktop development with C++* workload (MSVC build tools)
    + WebView2 (preinstalled on Windows 11).
  - **macOS:** Xcode command-line tools.
  - **Linux:** `webkit2gtk`, `libsoup`, build-essential, etc.

### Dev

```bash
npm install
npm run app        # tauri dev: builds the Rust core + serves the UI with HMR
```

Type a prompt in the bar to start a live `claude -p` session and watch it draw
itself. Toggle **sample** in the toolbar to replay a captured transcript
(`public/samples/sample-session.jsonl`) with no CLI or credits — great for
working on the UI offline.

> Opening `index.html` through plain `npm run dev` (browser, no Tauri) works
> too, but only **sample** mode is available there — the live bridge needs the
> desktop shell.

### Build

```bash
npm run app:build  # tauri build: produces a native installer
```

Captured live transcripts are teed to `sessions/*.jsonl` (gitignored).

---

## Direction

The product is **Claude Code with visual nodes**: a continuous, multi-turn
conversation rendered as a growing graph, with multiple chats in the sidebar.

The brief's worktree/parallel-orchestration milestone was **built and explored**
(preserved at tag [`milestone-2`](https://github.com/kamilch1k/droolcat-agent/tree/milestone-2))
but **removed from the product** — git worktrees / merge-back weren't the right
surface for a chat-shaped tool. The code lives in history if it's ever wanted.

## What works

- [x] **Continuous Agent Graph.** Live `claude -p` rendered as turns; each prompt
      appends below the previous result (no reset); `--resume` keeps context.
      Multiple chats, switchable in the sidebar.
- [x] **Code Graph.** Multi-language repo scanner (files + intra-repo import
      edges) → a directory-clustered structural graph; an `agents | code` view
      switch; highlight of the files the current chat has touched (cross-link).
      (`milestone-3`)

## Next

- [ ] **Working directory per chat** — choose the repo a chat operates on
      (right now live chats run in the home dir with default permissions).
- [ ] **Live Code Graph** — refresh agent-touched highlights as edits stream.
- [ ] **Parity polish** — MCP, hooks, slash commands, permissions, plan mode,
      checkpoints surfaced in the UI.

See [`docs/brief.md`](docs/brief.md) for the full product brief.

## Project layout

```
index.html              app shell (Vite entry)
src/
  main.js               wiring: sources → reducer → canvas
  graph.js              the stream-json → graph reducer + auto-layout
  canvas.js             pan/zoom renderer, status, inspector, camera
  icons.js              SVG icon set
  styles.css            design system
public/samples/         offline transcripts (sample = demo source)
src-tauri/
  src/lib.rs            the bridge (driver model)
  tauri.conf.json       window + bundle config
  capabilities/         permission capabilities
```
