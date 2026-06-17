# Droolcat Agent

> A visual cockpit on top of the Claude Code CLI. Droolcat drives Claude Code
> headless and turns a coding session into a live, navigable graph — agents,
> tool calls, reasoning, and (later) the project itself — instead of a
> scrolling wall of terminal text.

Droolcat is a **layer on top of the Claude Code CLI — not a fork, not an
extension.** It spawns and owns sessions (`claude -p --output-format
stream-json --verbose`), consumes the structured event stream, and renders it
as a spatial **Agent Graph**: an orchestrator fans out into agents, each
agent's read / edit / write / bash calls appear beneath it, and everything
funnels into a result node — live, as the stream arrives.

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
   {type:"result",…}                                            main.js   sources, prompt bar, worktrees
```

| Brief step | Where it lives |
| --- | --- |
| **Bridge** — spawn `claude -p`, read NDJSON, tee + broadcast | [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs) |
| **Parser / reducer** — event → graph mutation | [`src/graph.js`](src/graph.js) |
| **Auto-layout** — positions for live, arbitrary trees | `layout()` in [`src/graph.js`](src/graph.js) |
| **Graph canvas** — pan/zoom, status pills, inspector | [`src/canvas.js`](src/canvas.js) |
| **Prompt + steering** — drive / retarget sessions | [`src/main.js`](src/main.js) |

The bridge emits four events: `claude-event` (one parsed stream-json object),
`claude-stderr`, `claude-end` (`{ ok }`), `claude-error`.

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

## Milestones

- [x] **1 · Prove the loop (flat).** Bridge → parser → Agent Graph for a single
      real `claude -p` session, live.
- [x] **2 · Parallelism + worktrees.** One driven `claude -p` subprocess per
      lane in its own git worktree off a frozen base; deep per-agent detail;
      human-gated sequential merge-back with conflict detection. The flat loop
      is the N=1 case. (`milestone-2`)
- [x] **3 · Code Graph.** Multi-language repo scanner (files + intra-repo import
      edges) → a directory-clustered structural graph; an `agents | code` view
      switch; live highlight of the files the agent session is touching
      (cross-link). (`milestone-3`)
- [ ] **4 · Window Graph.** Workspace map tying editors, diffs, terminals, and
      agent branches together.
- [ ] **5 · Parity polish.** Surface MCP, hooks, slash commands, permissions,
      plan mode, and checkpoints through the UI.

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
