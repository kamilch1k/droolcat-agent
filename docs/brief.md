# Droolcat Agent — Product Brief

> **A visual cockpit on top of the Claude Code CLI.** Droolcat drives Claude Code headless and turns a coding session into a live, navigable graph — agents, tool calls, reasoning, and the project itself — instead of a scrolling wall of terminal text.

---

## 1. One-liner

**Droolcat Agent** is a desktop app that wraps the Claude Code CLI and renders everything it does — and everything it's working on — as live, zoomable graphs. You prompt it the way you prompt Claude Code today, but you *watch* the work as a tree of agents and actions, navigate the codebase as a structural graph, and see your whole workspace as a spatial map.

## 2. The problem

A terminal coding session is one linear column of text. The instant Claude is doing several things at once — or several agents are running in parallel across git worktrees — you lose the thread. You can't tell what each agent is touching, what's done, what's blocked, or how the pieces relate. Scrollback is not a workspace. Droolcat's bet: the work has *structure* (parallel branches, file dependencies, open views), and making that structure visible makes complex sessions legible, steerable, and fast to navigate.

## 3. How it relates to Claude Code

Droolcat is a **layer on top of the Claude Code CLI — not a fork and not an extension.** Claude Code stays the engine.

- It uses the **driver model**: Droolcat spawns and owns the sessions (`claude -p --output-format stream-json --verbose`), consumes the structured event stream Claude Code emits, and renders it.
- Because it *drives* Claude Code rather than just observing it, Droolcat can isolate parallel agents in their own **git worktrees**, control each branch, and capture full per-branch detail.
- **Critically, this means feature parity is mostly inherited, not rebuilt.** Every core capability below comes from the Claude Code engine Droolcat is driving — Droolcat's job is to expose them through a better surface, plus add what the terminal can't show.

## 4. Feature set

### 4A. Claude Code parity (baseline — must-have)

Droolcat must support the full Claude Code feature set, which it gets by driving the CLI directly:

- **Agentic coding from natural language** — understand a codebase, plan, make multi-file edits, run commands, iterate.
- **Core tools** — Read, Edit / MultiEdit, Write, Bash, Grep / Glob / LS, file search.
- **Web tools** — WebFetch / WebSearch.
- **MCP integration** — connect external tools and data sources via Model Context Protocol servers.
- **Subagents (Task)** — parallel and delegated work streams.
- **Hooks** — intercept lifecycle events programmatically.
- **Slash commands & custom commands.**
- **Plugins.**
- **Project memory** — `CLAUDE.md` and context files.
- **Permissions** — tool allow/deny, plan mode, approval gates.
- **Git operations** — diffs, commits, branches, and git worktree isolation.
- **Session management** — resume / continue, session IDs, checkpoints / undo.
- **Headless mode + stream-json + Agent SDK** — the programmatic backbone Droolcat is built on.
- **Model selection** — Opus / Sonnet / Haiku — and token / cost tracking.

> Anything Claude Code can do in the terminal, Droolcat can do — it's the same engine underneath. The difference is the surface.

### 4B. Droolcat differentiators (what basic Claude Code doesn't have)

**1. Agent Graph (core).** The live agent-action canvas. Every session renders as a top-down spatial tree: an orchestrator fans out into agents, each agent's read / edit / write / bash calls appear beneath it, parallel branches run in their own worktrees, and everything funnels into a result node. Nodes appear and change status (running / done / queued) in real time as the event stream arrives. Collapsed by default to kill the firehose; click any node for the full tool input, diff/output, and reasoning. Branches are **steerable** — talk to the orchestrator, or reach into a single running agent. Turns derive from prior results, so a session is a saved, navigable graph rather than lost scrollback.

**2. Code Graph (new).** A live structural graph of the *project itself* — files and modules as nodes, imports/dependencies as edges, with drill-down into symbols (functions, classes) and their relationships. It updates as agents edit code and **highlights the nodes agents are currently touching**, so you can see the blast radius of a change at a glance. Cross-linked with the Agent Graph: clicking an agent's edit node spotlights the affected file/symbol in the Code Graph, and vice versa. This is the "understand the codebase spatially" view the terminal can never give you.

**3. Window Graph (new).** A spatial map of your whole working context — every open view (file editor, diff, terminal, agent branch, preview) is a node on a zoomable board, with relationships drawn between them (this diff belongs to that agent; this file is imported by that one). Instead of hunting through tabs and terminal panes, the entire session is one navigable picture you pan and zoom. It's the bird's-eye workspace map that ties the Agent Graph, Code Graph, and your editing surfaces together.

**Plus, threaded through all three:**

- **Visible parallelism** — multiple agents running at once, each in its own worktree, shown as separate live branches converging on a result.
- **Detail on demand** — level-of-detail rendering: nodes simplify when zoomed out, expand when zoomed in or clicked.
- **Persistent, navigable history** — sessions are graphs you scroll and revisit, not throwaway scrollback.

## 5. Architecture — the core loop

1. **Bridge** — a local process spawns `claude -p` and reads its newline-delimited JSON event stream (and/or tails a captured `.jsonl` transcript). It broadcasts events to the UI (e.g. over SSE) and tees them to disk.
2. **Parser / reducer** — turns each event into a graph mutation: `tool_use` → a tool node, `Task` → an agent branch, `tool_result` → completes a node, assistant text deltas → live reasoning, `result` → the summary node.
3. **Auto-layout** — positions nodes as a tidy top-down tree for arbitrary, live-changing shapes (dagre / elkjs in the production build; no hand-placed coordinates).
4. **Graph canvas** — renders the Agent Graph, Code Graph, and Window Graph (React Flow for pan / zoom / drag), with status pills, worktree-colored branches, inline-expanding nodes, and an inspector.
5. **Prompt + steering** — branch a new turn from the previous result, or click one agent to steer just that branch; live prompts hit the bridge to start/continue sessions.

## 6. The honest hard parts (real engineering, not UI)

- **Worktree orchestration** — spawning one `claude` subprocess per branch, isolating each in its own git worktree, then merging. This is the load-bearing work; the canvas is the easy 10%.
- **Deep subagent detail** — a vanilla `claude -p` stream *summarizes* subagents. Full per-agent reasoning requires running each subagent as its own driven session (the driver model), not relying on auto-spawned Task summaries.
- **Auto-layout for live, arbitrary trees** — positions must be computed continuously as nodes stream in; this is where dagre/elkjs earn their place.
- **Code Graph extraction** — building and incrementally updating a dependency/symbol graph from the repo (language servers / tree-sitter / static analysis) and keeping it in sync as agents edit.
- **Cost** — headless usage bills against the Agent SDK credit pool, and parallel agents multiply it; metering and caps matter.

## 7. Build milestones

1. **Prove the loop (flat).** Bridge → parser → Agent Graph for a single real `claude -p` session. Orchestrator → tool calls → result, live. *(Prototype already does this against captured transcripts.)*
2. **Parallelism + worktrees.** Driver model: one subprocess per branch in its own worktree; deep per-agent detail; merge-back.
3. **Code Graph.** Static analysis of the repo into a structural graph; live highlight of agent-touched nodes; cross-link to the Agent Graph.
4. **Window Graph.** Workspace map tying together editors, diffs, terminals, and agent branches.
5. **Parity polish.** Surface the full Claude Code toolset (MCP, hooks, slash commands, permissions, plan mode, checkpoints) through Droolcat's UI.

## 8. Prototype assets (already built)

- `agentcanvas.html` — the live app: parser, auto-layout, light spatial Agent Graph, SSE / file / demo sources, node inspector.
- `graph.js` — the event→tree reducer + layout, tested against a real-shaped transcript.
- `sample-session.jsonl` — a realistic Claude Code stream-json transcript for offline development.
- *Next:* `bridge.mjs` — pure-Node SSE server that spawns Claude Code and streams events live.

## 9. Open decisions

- **Steering model** — prompt only the orchestrator, or click-to-steer individual agents (recommended: both — input defaults to orchestrator, selecting a node retargets it).
- **Primary view** — does the Agent Graph or the Window Graph become the default home screen?
- **Code Graph depth** — file/module level first, symbol/call level later?
- **Platform** — Tauri vs Electron (driver model needs a real local process either way).

---

### One-line version

**Droolcat Agent: a Miro-board-style cockpit on top of the Claude Code CLI that turns a coding session — and the project it's working on — into live, navigable graphs of agents, actions, code, and windows, making parallel multi-worktree work watchable and steerable instead of a wall of terminal text.**
