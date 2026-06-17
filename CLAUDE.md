# Droolcat Agent — notes for Claude Code

Droolcat is **"Claude Code with visual nodes"**: a Tauri desktop app that drives
the Claude Code CLI headless and renders its `stream-json` stream as a live,
continuous, multi-turn graph. A *layer on top of* Claude Code, not a fork.

## Mental model

- A **chat** = one continuous Claude Code conversation (its own Claude
  `session_id`, its own graph). The sidebar lists chats; "New chat" starts fresh.
- A **turn** = one prompt: `[You]` → the reads/edits/bash/subagents it runs →
  `[Result]`. The next prompt **appends** below the result (never resets);
  `--resume` keeps the Claude conversation coherent across turns.
- A second view (`agents | code`) maps the project as a file/import **Code Graph**.
- **No git worktrees / merge** — that was explored at tag `milestone-2` and
  removed. Don't reintroduce it.

## Where things are

- **Bridge (Rust):** `src-tauri/src/lib.rs` — `start_session(session_id, prompt,
  cwd, resume)` spawns `claude -p … [--resume <id>]`, streams `claude-event`
  (raw stream-json object) / `claude-stderr` / `claude-end {ok}`. `stop_session`
  kills a turn. `find_claude()` bypasses PATH. `src-tauri/src/codegraph.rs` is the
  repo scanner (`scan_code_graph`).
- **Reducer (JS):** `src/graph.js` — `GraphModel`: `beginTurn(prompt)` appends a
  turn chained from the last result; `apply(evt)` grows it; `endTurn(ok)` closes
  it; `layout()` is a tidy tree over the growing chain. The heart — keep it pure.
- **Renderer:** `src/canvas.js` — reconciles DOM, edges, status, camera,
  inspector. Renders node types `prompt | tool | agent | result | file`.
- **Code Graph:** `src/codegraph.js` (`CodeGraphModel`, Canvas-compatible).
- **Wiring:** `src/main.js` — chats (sessions array), multi-turn send + resume,
  `agents|code` view switch, sample replay.

## Conventions

- Frontend is **vanilla ES modules + Vite** (no framework).
- stream-json the reducer handles: `system/init`, `assistant` (`text`,
  `tool_use`), `user` (`tool_result`), `result`. Capture `session_id` from the
  `system` event for the next turn's `--resume`.
- **Offline dev:** the **sample** source replays
  `public/samples/sample-session.jsonl` through the same reducer (each replay =
  a new turn). `sample-codegraph.json` backs the Code view in the browser.
- One live turn at a time per chat (`sendPrompt` guards on `runningId`).

## Running / verifying

- `npm install` then `npm run app` (= `tauri dev`). Needs Rust + the platform
  Tauri toolchain (Windows: MSVC C++ build tools + WebView2).
- Can't drive the live Tauri window via computer-use (dev binary isn't a
  registered app) → verify the frontend via the vite **browser preview**
  (`launch.json` → `droolcat-web` on :1420) with render-path `eval`s; verify
  Rust via `cargo test` / direct CLI.
- Live chats currently run in the home dir under default permissions (reads/greps
  stream; autonomous edits need a per-chat working dir + permissions — see README "Next").
