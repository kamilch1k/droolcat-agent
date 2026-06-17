# Droolcat Agent — notes for Claude Code

Droolcat is a **Tauri desktop app** that drives the Claude Code CLI headless
and renders its `stream-json` event stream as a live Agent Graph. It is a
*layer on top of* Claude Code (the driver model), not a fork.

## Where things are

- **Bridge (Rust):** `src-tauri/src/lib.rs` — `start_session` spawns
  `claude -p --output-format stream-json --verbose`, reads stdout line-by-line,
  tees to `sessions/*.jsonl`, and emits `claude-event` / `claude-stderr` /
  `claude-end` over Tauri's event bus. `find_claude()` bypasses PATH.
- **Reducer (JS):** `src/graph.js` — `GraphModel.apply(evt)` turns each
  stream-json event into graph mutations; `layout(model)` does the tidy-tree
  positioning. This is the heart; keep it pure and event-driven.
- **Renderer:** `src/canvas.js` — `Canvas` reconciles DOM, draws edges,
  animates status, owns camera + inspector. Presentation only.
- **Wiring:** `src/main.js` — source toggle (live bridge / sample replay),
  prompt bar, worktree sidebar.

## Conventions

- The frontend is **vanilla ES modules + Vite** (no framework). The brief notes
  React Flow + dagre/elkjs as the eventual production canvas; not adopted yet.
- Keep the design-system CSS variables in `src/styles.css` (warm neutrals,
  `--wt-*` worktree colors). Match the existing visual language.
- stream-json shapes the reducer must handle: `system/init`, `assistant`
  (content blocks: `text`, `tool_use`), `user` (`tool_result`), `result`.
- **Offline dev:** use the **sample** source — it replays
  `public/samples/sample-session.jsonl` through the same reducer, no CLI/credits.

## Running / verifying

- `npm install` then `npm run app` (= `tauri dev`). Needs Rust + the platform
  Tauri toolchain (Windows: MSVC C++ build tools + WebView2).
- Pure-browser `npm run dev` works for UI/sample work, but live mode needs the
  Tauri shell (`window.__TAURI_INTERNALS__` gates it).
- Live mode runs a real `claude -p`. Reads/greps stream under default
  permissions; broader autonomy (edits/bash) depends on the target repo's
  permission settings — surfacing a permissions UI is milestone 5.

## Status

Milestone 1 (prove the flat loop) is the current scope. Parallel worktrees,
Code Graph, and Window Graph are later milestones — see `docs/brief.md`.
