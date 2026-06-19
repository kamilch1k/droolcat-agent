// graph.js — the event -> graph reducer + auto-layout.
//
// Droolcat is "Claude Code with visual nodes": a session is a CONTINUOUS
// conversation. Each prompt appends a new TURN — a user-prompt node chained
// below the previous turn's result — so the graph grows downward as you talk,
// it is never reset. Within a turn: prompt -> the assistant's tool calls (and
// any subagents) -> a result node. The next prompt continues from that result.
//
//   beginTurn(prompt)  -> a prompt node, chained from the last result
//   apply(evt)         -> grows the current turn (system/assistant/user/result)
//   endTurn(ok)        -> closes the turn if the stream ended without a result

const KIND_BY_TOOL = {
  Read: "read", NotebookRead: "read",
  Edit: "edit", MultiEdit: "edit", NotebookEdit: "edit", Update: "edit",
  Write: "write",
  Bash: "bash", BashOutput: "bash", KillShell: "bash",
  Grep: "search", Glob: "search", LS: "search",
  WebFetch: "web", WebSearch: "web",
  TodoWrite: "todo",
};
const TITLE_BY_TOOL = {
  Read: "read", NotebookRead: "read",
  Edit: "edit", MultiEdit: "edit", NotebookEdit: "edit",
  Write: "write", Bash: "bash", Grep: "grep", Glob: "glob", LS: "ls",
  WebFetch: "fetch", WebSearch: "search", TodoWrite: "todo",
};

export const SIZES = {
  prompt: { w: 300, h: 56 },
  say: { w: 300, h: 92 },
  think: { w: 300, h: 70 },
  agent: { w: 196, h: 104 },
  tool: { w: 168, h: 74 },
  result: { w: 440, h: 176 },
  lane: { w: 244, h: 92 },
};

// subagents (Task) get a cycling accent so parallel branches read distinctly
const SUB_PALETTE = ["var(--wt-frontend)", "var(--wt-api)", "var(--wt-tests)", "#b6478f", "#3a86c8"];
// agent lanes (parallel conversations in one board) each get their own accent
const LANE_PALETTE = ["var(--wt-frontend)", "var(--wt-api)", "var(--wt-tests)", "#b6478f", "#3a86c8", "#c7711b"];

// MCP tools arrive named `mcp__<server>__<method>` — split them so we can show
// a clean method title + which server it came from, not the raw underscored id.
function isMcp(tool) { return typeof tool === "string" && tool.startsWith("mcp__"); }
function mcpParts(tool) {
  if (!isMcp(tool)) return null;
  const parts = tool.split("__").filter(Boolean);   // ["mcp", server, method...]
  return { server: parts[1] || "mcp", method: parts.slice(2).join("__") || parts[1] || "tool" };
}
function deUnderscore(s) { return String(s || "").replace(/_+/g, " ").trim(); }

function kindOf(tool) {
  if (KIND_BY_TOOL[tool]) return KIND_BY_TOOL[tool];
  if (isMcp(tool)) return "mcp";
  return "call";                                      // unknown tool: a neutral call, NOT a file read
}
function titleOf(tool) {
  if (TITLE_BY_TOOL[tool]) return TITLE_BY_TOOL[tool];
  const mcp = mcpParts(tool);
  if (mcp) return clip(deUnderscore(mcp.method), 22);
  return tool;                                        // unknown tool: keep its real (cased) name
}
function tail(p, n = 2) {
  if (!p) return "";
  const parts = String(p).replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.slice(-n).join("/");
}
function clip(s, n) {
  s = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
export function fmtTokens(n) {
  if (!n) return null;
  return n >= 1000 ? (n / 1000).toFixed(1) + "k tok" : n + " tok";
}
function targetOf(tool, input = {}) {
  const mcp = mcpParts(tool);
  if (mcp) return clip(deUnderscore(mcp.server), 28);
  switch (tool) {
    case "Read": case "Edit": case "MultiEdit": case "Write":
      return tail(input.file_path);
    case "NotebookEdit": case "NotebookRead":
      return tail(input.notebook_path);
    case "Bash": return clip(input.command, 44);
    case "Grep": return clip(input.pattern, 36);
    case "Glob": return clip(input.pattern, 36);
    case "LS": return tail(input.path, 2);
    case "WebFetch": try { return new URL(input.url).host; } catch { return clip(input.url, 36); }
    case "WebSearch": return clip(input.query, 36);
    case "TodoWrite": return (input.todos?.length || "") + " todos";
    default: return clip(input.file_path || input.path || input.command || "", 36);
  }
}
function resultText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => (typeof b === "string" ? b : b.text || "")).join("\n");
  return String(content.text || "");
}
function diffFromEdit(input) {
  if (!input) return null;
  if (Array.isArray(input.edits)) return input.edits.flatMap((e) => diffPair(e.old_string, e.new_string)).slice(0, 40);
  if (input.old_string != null || input.new_string != null) return diffPair(input.old_string, input.new_string);
  return null;
}
// total lines added / removed by an Edit or MultiEdit (blank-inclusive, uncapped)
function editCounts(input) {
  if (!input) return [0, 0];
  const pairs = Array.isArray(input.edits) ? input.edits : [{ old_string: input.old_string, new_string: input.new_string }];
  let ad = 0, rm = 0;
  for (const e of pairs) {
    if (e.new_string != null) ad += String(e.new_string).split("\n").length;
    if (e.old_string != null) rm += String(e.old_string).split("\n").length;
  }
  return [ad, rm];
}
function diffPair(oldS, newS) {
  const rows = [];
  String(oldS || "").split("\n").forEach((l) => l !== "" && rows.push(["rm", "- " + l]));
  String(newS || "").split("\n").forEach((l) => l !== "" && rows.push(["ad", "+ " + l]));
  return rows;
}

// ---- the model -----------------------------------------------------------

export class GraphModel {
  constructor() { this.reset(); }

  reset() {
    this.nodes = [];
    this.edges = [];
    this.byId = {};
    this.seq = 0;
    this.meta = { model: null, cwd: null, sessionId: null };
    this.wtMap = { main: { name: "main", color: "var(--wt-main)" } };
    // a chat can hold multiple independent conversation LANES (parallel agents
    // in one board). Each lane keeps its own tail so turns chain within it.
    this.lanes = {};            // laneId -> { lastResultId, turns, headerId }
    this.laneOrder = [];
    this.laneOffset = {};       // laneId -> { dx, dy }  (user-dragged lane position)
    this.laneCompact = {};      // laneId -> bool        (compact view: hide tool detail)
    this.turn = null;           // current (active) turn's cursor; carries laneId
    this.turnCount = 0;
    this.running = false;
    this.subCount = 0;
    this.cost = 0;              // running session cost in USD (sum of result costs)
  }

  _lane(laneId) {
    if (!this.lanes[laneId]) { this.lanes[laneId] = { lastResultId: null, turns: 0, headerId: null }; this.laneOrder.push(laneId); }
    return this.lanes[laneId];
  }

  // every lane gets a header card at its top — it shows model/mode/context,
  // doubles as the "waiting for input" node for a freshly-spawned lane, and is
  // the drag handle for moving the whole lane around the board.
  ensureLaneHeader(laneId = "main", opts = {}) {
    const lane = this._lane(laneId);
    if (lane.headerId != null && this.byId[lane.headerId]) return this.byId[lane.headerId];
    const isMain = laneId === "main";
    const isHelper = laneId === "board";
    const idx = this.laneOrder.indexOf(laneId);
    if (!isMain && !this.wtMap[laneId]) {
      this.wtMap[laneId] = { name: isHelper ? "board helper" : "lane " + (idx + 1), color: isHelper ? "#b5791b" : LANE_PALETTE[idx % LANE_PALETTE.length] };
    }
    const h = this._add({
      type: "lane", lane: laneId, wt: isMain ? "main" : laneId, helper: isHelper,
      title: isMain ? "main lane" : isHelper ? "Board Helper" : "Agent lane " + (idx + 1),
      status: "wait", model: opts.model || this.meta.model || "claude",
      mode: opts.mode || this.meta.mode || "bypass", ctx: "", turns: 0, detail: {},
    });
    lane.headerId = h.id;
    if (lane.lastResultId == null) lane.lastResultId = h.id; // first prompt chains under the header
    return h;
  }

  // create a lane that is waiting for its first prompt (right-click → new lane)
  beginLane(laneId, opts = {}) {
    const h = this.ensureLaneHeader(laneId, opts);
    h.status = "wait";
    return h;
  }

  _add(node) {
    node.id = "n" + this.seq++;
    node.status = node.status || "run";
    node.detail = node.detail || {};
    if (!node.wt) node.wt = "main";
    if (node.lane == null && this.turn) node.lane = this.turn.laneId;
    this.nodes.push(node);
    this.byId[node.id] = node;
    return node;
  }
  _edge(from, to, opts = {}) {
    if (from == null || to == null) return;
    this.edges.push({ from, to, ...opts });
  }

  // start a new turn from a user prompt — appended, never resetting
  beginTurn(prompt, laneId = "main") {
    // close any still-open turn so the chain stays well-formed
    if (this.turn && !this.turn.resultId) this.endTurn(true);
    const lane = this._lane(laneId);
    // give new lanes a header; don't retro-add one to pre-existing chats
    let header = lane.headerId != null ? this.byId[lane.headerId] : null;
    if (!header && lane.turns === 0) header = this.ensureLaneHeader(laneId);
    this.turnCount++; lane.turns++;
    const p = this._add({
      type: "prompt", title: "You", text: prompt, turn: lane.turns, lane: laneId,
      status: "done", detail: {},
    });
    if (lane.lastResultId) this._edge(lane.lastResultId, p.id, { turn: true });
    if (header) {
      if (this.meta.pickedModel) header.model = this.meta.pickedModel;
      else if (this.meta.model) header.model = this.meta.model;
      if (this.meta.mode) header.mode = this.meta.mode;
      header.status = "run"; header.turns = lane.turns;
    }
    this.turn = { laneId, anchorId: p.id, lastId: p.id, byToolUse: {}, frontier: new Set([p.id]), tokAcc: 0, resultId: null, streamSay: null, streamBlocks: {}, usedPartials: false };
    this.running = true;
    return p;
  }

  // id of the most recently added real node in a lane (skips the lane header) —
  // the true tail to chain onto when the turn cursor has been lost
  _laneTail(laneId = "main") {
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i];
      if (n.type === "lane") continue;
      if ((n.lane || "main") === laneId) return n.id;
    }
    return null;
  }
  // re-open the lane's previous turn so an out-of-band assistant message chains
  // onto the real tail instead of spawning a phantom "(session)" prompt branch
  resumeTurn(laneId = "main") {
    const tailId = this._laneTail(laneId);
    if (tailId == null) return false;
    this.turn = { laneId, anchorId: tailId, lastId: tailId, byToolUse: {}, frontier: new Set([tailId]), tokAcc: 0, resultId: null, streamSay: null, streamBlocks: {}, usedPartials: false };
    this.running = true;
    return true;
  }

  apply(evt) {
    if (!evt || typeof evt !== "object") return;
    if (!this.turn && !this.resumeTurn()) this.beginTurn("(session)");
    switch (evt.type) {
      case "system": return this._system(evt);
      case "stream_event": return this._streamEvent(evt);
      case "assistant": return this._assistant(evt);
      case "user": return this._user(evt);
      case "result": return this._result(evt);
    }
  }

  // chain a node after the turn's current tail
  _chain(node) {
    const t = this.turn;
    this._edge(t.lastId, node.id);
    t.frontier.delete(t.lastId);
    t.frontier.add(node.id);
    t.lastId = node.id;
  }
  _makeSay(text) {
    return this._add({ type: "say", title: "Claude", text: String(text || ""), wt: "main", status: "run", detail: {} });
  }
  _makeThink(text) {
    return this._add({ type: "think", title: "Thinking", text: String(text || ""), wt: "main", status: "run", detail: {} });
  }
  _makeToolNode(name, input = {}) {
    if (name === "Task") {
      const color = SUB_PALETTE[this.subCount++ % SUB_PALETTE.length];
      const wt = "sub" + this.subCount;
      this.wtMap[wt] = { name: clip(input.subagent_type || "subagent", 16), color };
      return this._add({ type: "agent", wt, title: clip(input.description || input.subagent_type || "subagent", 22), role: input.subagent_type || "agent", thought: clip(input.prompt || input.description || "", 80), status: "run", detail: { think: input.prompt || "", input, events: [] } });
    }
    return this._add({ type: "tool", kind: kindOf(name), wt: "main", title: titleOf(name), file: targetOf(name, input), status: "run", detail: { input } });
  }
  _fillTool(node, name, input = {}) {
    node.detail.input = input;
    node.kind = kindOf(name);
    node.title = titleOf(name);
    const f = targetOf(name, input);
    if (f) node.file = f;
  }

  // live token stream (--include-partial-messages): grow say nodes + open tools
  _streamEvent(evt) {
    const ev = evt.event;
    const t = this.turn;
    if (!ev || !t) return;
    t.usedPartials = true;
    if (ev.type === "content_block_start") {
      const cb = ev.content_block || {};
      if (cb.type === "text") {
        const say = this._makeSay("");
        this._chain(say);
        t.streamSay = say;
        t.streamBlocks[ev.index] = { type: "text", node: say };
      } else if (cb.type === "thinking") {
        const think = this._makeThink("");
        this._chain(think);
        t.streamBlocks[ev.index] = { type: "thinking", node: think };
      } else if (cb.type === "tool_use") {
        const node = this._makeToolNode(cb.name || "tool", cb.input || {});
        this._chain(node);
        if (cb.id) t.byToolUse[cb.id] = node;
        t.streamBlocks[ev.index] = { type: "tool", node };
      }
    } else if (ev.type === "content_block_delta") {
      const blk = t.streamBlocks[ev.index], d = ev.delta || {};
      if (d.type === "text_delta" && blk && blk.type === "text" && blk.node) {
        blk.node.text = (blk.node.text || "") + (d.text || "");
      } else if (d.type === "thinking_delta" && blk && blk.type === "thinking" && blk.node) {
        blk.node.text = (blk.node.text || "") + (d.thinking || "");
      }
    } else if (ev.type === "content_block_stop") {
      const blk = t.streamBlocks[ev.index];
      if (blk && blk.node && (blk.type === "text" || blk.type === "thinking")) { blk.node.status = "done"; if (t.streamSay === blk.node) t.streamSay = null; }
    }
  }

  _system(evt) {
    if (evt.subtype && evt.subtype !== "init") return;
    this.meta.model = evt.model || this.meta.model;
    this.meta.cwd = evt.cwd || this.meta.cwd;
    this.meta.sessionId = evt.session_id || this.meta.sessionId;
    const p = this.byId[this.turn.anchorId];
    if (p && evt.model) p.model = evt.model;
    const h = this.byId[this._lane(this.turn.laneId).headerId];
    if (h && evt.model && !this.meta.pickedModel) h.model = evt.model;
  }

  _assistant(evt) {
    const t = this.turn;
    const msg = evt.message || {};
    const content = Array.isArray(msg.content) ? msg.content : [];
    if (msg.model) this.meta.model = msg.model;
    const u = msg.usage || {};
    const tok = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    if (tok) t.tokAcc += tok;
    // latest context-window usage = this message's input + cached input
    const ctxNow = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    if (ctxNow) t.ctxNow = ctxNow;

    if (t.usedPartials) {
      // nodes already streamed in via _streamEvent — fill tool inputs that
      // arrived empty at block_start; don't duplicate
      for (const block of content) {
        if (block.type !== "tool_use") continue;
        const node = t.byToolUse[block.id];
        if (node) this._fillTool(node, block.name || "tool", block.input || {});
        else { const n = this._makeToolNode(block.name || "tool", block.input || {}); this._chain(n); if (block.id) t.byToolUse[block.id] = n; }
      }
      return;
    }

    // no partial stream — build nodes from the full message, in order, so the
    // turn reads You -> [Claude's words] -> tool -> ... like a conversation
    for (const block of content) {
      if (block.type === "thinking" && block.thinking && block.thinking.trim()) {
        const think = this._makeThink(clip2(block.thinking.trim(), 800)); think.status = "done"; this._chain(think);
      } else if (block.type === "text" && block.text && block.text.trim()) {
        const say = this._makeSay(clip2(block.text.trim(), 800)); say.status = "done"; this._chain(say);
      } else if (block.type === "tool_use") {
        const node = this._makeToolNode(block.name || "tool", block.input || {});
        this._chain(node); if (block.id) t.byToolUse[block.id] = node;
      }
    }
  }

  _user(evt) {
    const t = this.turn;
    const content = Array.isArray(evt.message?.content) ? evt.message.content : [];
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      const node = t.byToolUse[block.tool_use_id];
      if (!node) continue;
      const out = resultText(block.content);
      node.status = "done";
      const isErr = block.is_error === true;
      if (node.type === "tool") {
        const diff = (node.kind === "edit" && !isErr) ? diffFromEdit(node.detail.input) : null;
        if (diff && diff.length) {
          node.detail.diff = diff;
          const [ad, rm] = editCounts(node.detail.input);
          node.resultChip = `+${ad} −${rm}`;
        } else {
          node.detail.out = clip2(out, 1600);
          if (node.kind === "read" && !isErr) { const ln = String(out).split("\n").length; if (ln > 1) node.resultChip = `${ln} lines`; }
          if (node.kind === "write" && !isErr) node.resultChip = "written";
        }
        if (isErr) node.donePill = { l: "error", k: "danger" };
        else if (node.kind === "bash") node.donePill = bashPill(out);
      } else if (node.type === "agent") {
        node.detail.out = clip2(out, 1600);
        if (isErr) node.donePill = { l: "error", k: "danger" };
        else node.donePill = { l: "done", k: "success" };
      }
    }
  }

  _result(evt) {
    const t = this.turn;
    if (!t || t.resultId) return;
    if (t.streamSay) { t.streamSay.status = "done"; t.streamSay = null; } // close any open stream
    const isErr = evt.is_error === true || evt.subtype === "error";
    const res = this._add({
      type: "result", wt: "main", status: "done",
      title: isErr ? "Failed" : "Result",
      summary: evt.result || (isErr ? "The turn ended with an error." : "Done."),
      turn: this.turnCount,
      meta: metaLine(evt),
      donePill: isErr ? { l: "error", k: "danger" } : null,
      detail: {
        model: this.meta.model,
        tokens: typeof evt.total_cost_usd === "number" ? `$${evt.total_cost_usd.toFixed(3)}` : fmtTokens(t.tokAcc),
        events: resultEvents(evt),
      },
    });
    const leaves = [...t.frontier].filter((id) => id !== res.id);
    (leaves.length ? leaves : [t.anchorId]).forEach((id) => this._edge(id, res.id, { funnel: true }));
    t.resultId = res.id;
    const lane = this._lane(t.laneId);
    lane.lastResultId = res.id;
    if (typeof evt.total_cost_usd === "number") this.cost += evt.total_cost_usd;
    const h = this.byId[lane.headerId];
    if (h) { h.status = "idle"; h.turns = lane.turns; const ctxTok = t.ctxNow || t.tokAcc; h.ctxTokens = ctxTok; h.ctx = fmtTokens(ctxTok) || ""; }
    this.running = false;
  }

  // stream ended (claude-end) — if no result event arrived, synthesize one so
  // the turn closes and the next prompt has something to chain from
  endTurn(ok, reason) {
    const t = this.turn;
    if (t && !t.resultId) {
      const msg = ok ? "Done." : (reason && String(reason).trim() ? String(reason).trim() : "The turn ended without a response.");
      this._result({ result: msg, is_error: !ok });
    }
    this.running = false;
  }

  // ---- observing a real Claude Code session (its .jsonl transcript) -------
  // The persisted transcript has no `result` events, so turns are chained under
  // the previous turn's tail instead of a result node. Tool calls + their
  // results, the assistant's words, and each user prompt render like a live
  // conversation. Everything on disk is already complete, so markIdle() clears
  // the "running" state after each batch.
  ingestTranscript(objs) {
    if (!Array.isArray(objs)) return;
    for (const o of objs) {
      if (!o || o.isSidechain || !o.message) continue;
      if (o.type === "user") {
        const c = o.message.content;
        const isToolResult = Array.isArray(c) && c.some((b) => b && b.type === "tool_result");
        if (isToolResult) { if (this.turn) this.apply({ type: "user", message: o.message }); continue; }
        const text = typeof c === "string"
          ? c
          : Array.isArray(c) ? c.filter((b) => b && b.type === "text").map((b) => b.text || "").join("\n") : "";
        const trimmed = text.trim();
        // skip harness-injected messages (slash commands, hooks, background-task
        // notifications, system reminders) — they aren't real user prompts
        if (!trimmed || /^<(command-|local-command|task-notification|system-reminder|user-prompt-submit-hook|bash-std|session-start|post-tool)/i.test(trimmed)) continue;
        // chain the next turn under the prior turn's tail (no result events here)
        if (this.turn) { this._lane("main").lastResultId = this.turn.lastId; this.turn = null; }
        this.beginTurn(clip2(trimmed, 2000), "main");
      } else if (o.type === "assistant") {
        // an assistant line with no open turn = the prior turn's cursor was lost
        // across a poll boundary; resume its real tail rather than fabricating a
        // "(session)" prompt. Only fall back to "(session)" if the lane is empty.
        if (!this.turn && !this.resumeTurn("main")) this.beginTurn("(session)", "main");
        this.apply({ type: "assistant", message: o.message });
      }
    }
    this.markIdle();
  }

  // observed transcript lines are complete on disk — clear run state, but leave
  // any tool whose result hasn't been written yet showing "running" (its
  // tool_result lands in a later poll). Keep the turn cursor open for appends.
  markIdle() {
    const pending = new Set();
    if (this.turn && this.turn.byToolUse) {
      for (const id in this.turn.byToolUse) {
        const n = this.turn.byToolUse[id];
        if (n && !n.donePill && !(n.detail && (n.detail.out || n.detail.diff))) pending.add(n.id);
      }
    }
    for (const n of this.nodes) if (n.status === "run" && !pending.has(n.id)) n.status = "done";
    this.running = false;
    if (this.turn) {
      this.turn.streamSay = null;
      // observed sessions have no result event — populate the lane gauge here
      const h = this.byId[this._lane(this.turn.laneId).headerId];
      if (h && this.turn.ctxNow) { h.ctxTokens = this.turn.ctxNow; h.ctx = fmtTokens(this.turn.ctxNow) || ""; }
    }
  }

  // hand-off: close an open observed turn the way ingestTranscript chains turns
  // (under the last real node), so resuming doesn't inject a fake "Done." result
  closeObservedTurn() {
    if (this.turn && !this.turn.resultId) {
      this._lane(this.turn.laneId).lastResultId = this.turn.lastId;
      this.turn = null;
    }
  }

  stats() {
    let running = 0;
    for (const n of this.nodes) if ((n.type === "tool" || n.type === "agent") && n.status === "run") running++;
    return { running, busy: this.running, turns: this.turnCount, done: !this.running, nodes: this.nodes.length, cost: this.cost };
  }

  // ---- persistence (the live `turn` cursor is transient, not saved) -------
  toJSON() {
    return {
      nodes: this.nodes, edges: this.edges, meta: this.meta, wtMap: this.wtMap,
      lanes: this.lanes, laneOrder: this.laneOrder,
      laneOffset: this.laneOffset, laneCompact: this.laneCompact,
      turnCount: this.turnCount, subCount: this.subCount, seq: this.seq, cost: this.cost,
    };
  }
  fromJSON(d) {
    this.reset();
    if (!d) return this;
    this.nodes = Array.isArray(d.nodes) ? d.nodes : [];
    this.edges = Array.isArray(d.edges) ? d.edges : [];
    this.meta = d.meta || this.meta;
    this.wtMap = d.wtMap || this.wtMap;
    this.lanes = d.lanes || {};
    this.laneOrder = d.laneOrder || Object.keys(this.lanes);
    this.laneOffset = d.laneOffset || {};
    this.laneCompact = d.laneCompact || {};
    this.turnCount = d.turnCount || 0;
    this.subCount = d.subCount || 0;
    this.seq = d.seq || this.nodes.length;
    this.cost = d.cost || 0;
    this.byId = {};
    for (const n of this.nodes) { this.byId[n.id] = n; n.h = undefined; normalizeNode(n); } // re-measure on render + upgrade old nodes
    this.turn = null;
    this.running = false;
    return this;
  }
}

// older reducer versions baked MCP/unknown tools into saved chats with the raw
// `mcp__server__method` string as the title, kind "read" (→ magnifier icon +
// "reading…" pill), and a bogus "N lines" chip. Re-derive a clean title/kind/
// server subtitle from the stored name so reloading an old chat looks right.
function normalizeNode(n) {
  if (!n || n.type !== "tool") return;
  if (typeof n.title === "string" && n.title.startsWith("mcp__")) {
    const mcp = mcpParts(n.title);
    n.kind = "mcp";
    n.title = clip(deUnderscore(mcp.method), 22);
    n.file = clip(deUnderscore(mcp.server), 28);
    if (typeof n.resultChip === "string" && /^\d+\s*lines$/.test(n.resultChip)) n.resultChip = undefined;
  }
}

function clip2(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n - 1) + "\n…" : s; }
function bashPill(out) {
  const m = /(\d+)\s+pass(?:ed|ing)/i.exec(out);
  const f = /(\d+)\s+fail(?:ed|ing)/i.exec(out);
  if (f && +f[1] > 0) return { l: `${f[1]} failing`, k: "danger" };
  if (m) return { l: `${m[1]} passed`, k: "success" };
  if (/error|exception|traceback/i.test(out)) return { l: "error", k: "danger" };
  return null;
}
function metaLine(evt) {
  const bits = [];
  if (evt.num_turns) bits.push(`${evt.num_turns} steps`);
  if (typeof evt.total_cost_usd === "number") bits.push(`$${evt.total_cost_usd.toFixed(3)}`);
  if (evt.duration_ms) bits.push(`${(evt.duration_ms / 1000).toFixed(1)}s`);
  return bits.join(" · ");
}
function resultEvents(evt) {
  const e = [];
  if (evt.duration_ms) e.push([`${(evt.duration_ms / 1000).toFixed(1)}s`, "turn duration"]);
  if (evt.num_turns) e.push(["", `${evt.num_turns} model steps`]);
  if (typeof evt.total_cost_usd === "number") e.push(["", `$${evt.total_cost_usd.toFixed(4)} billed`]);
  return e;
}

// ---- auto-layout (tidy tree; the turn chain grows downward) --------------

export function layout(model) {
  const { nodes, edges } = model;
  if (!nodes.length) return { w: 0, h: 0 };

  const childrenOf = {}, primaryParent = {}, incoming = {};
  nodes.forEach((n) => (childrenOf[n.id] = []));
  edges.forEach((e) => { if (incoming[e.to] == null) incoming[e.to] = e.from; });
  nodes.forEach((n) => {
    const p = incoming[n.id];
    if (p != null && childrenOf[p]) { primaryParent[n.id] = p; childrenOf[p].push(n.id); }
  });

  // longest-path depth (DAG: turns + funnels + turn-chain all point forward)
  const depth = {};
  nodes.forEach((n) => (depth[n.id] = 0));
  for (let i = 0; i < nodes.length + 2; i++) {
    let changed = false;
    edges.forEach((e) => { if (depth[e.to] < depth[e.from] + 1) { depth[e.to] = depth[e.from] + 1; changed = true; } });
    if (!changed) break;
  }

  const roots = nodes.filter((n) => primaryParent[n.id] == null).map((n) => n.id);
  const COL = 212, VGAP = 26;
  const x = {};
  let cursor = 0;
  const place = (id) => {
    const kids = childrenOf[id];
    if (!kids.length) { x[id] = cursor; cursor += COL; return; }
    kids.forEach(place);
    x[id] = (x[kids[0]] + x[kids[kids.length - 1]]) / 2;
  };
  roots.forEach(place);

  // row height per depth = tallest node at that depth, so a tall result node
  // never overlaps the next turn's prompt (which hid the connecting edge)
  let maxDepth = 0;
  const rowH = {};
  nodes.forEach((n) => {
    const h = (typeof n.h === "number" && n.h) ? n.h : (SIZES[n.type] || SIZES.tool).h;
    const d = depth[n.id];
    rowH[d] = Math.max(rowH[d] || 0, h);
    maxDepth = Math.max(maxDepth, d);
  });
  const yOf = {};
  let acc = 0;
  for (let d = 0; d <= maxDepth; d++) { yOf[d] = acc; acc += (rowH[d] || SIZES.tool.h) + VGAP; }

  // 1) base positions (centered per tidy-tree column)
  nodes.forEach((n) => {
    const sz = SIZES[n.type] || SIZES.tool;
    n.w = n.kind === "todo" ? 236 : sz.w;
    if (!(typeof n.h === "number" && n.h)) n.h = sz.h; // keep measured height if set
    n.x = (x[n.id] || 0) + COL / 2 - n.w / 2;
    n.y = yOf[depth[n.id]] || 0;
  });

  // 1.5) de-overlap rows: within each lane+depth, push nodes apart so their
  //      boxes never intersect horizontally. The tidy tree assumes one node per
  //      row in a linear turn; forked structures (e.g. graphs persisted by older
  //      reducer versions that branched a turn into siblings) or wide nodes can
  //      land two boxes on the same row. This pass makes overlap impossible.
  const HGAP = 30;
  const byLaneRow = {};
  nodes.forEach((n) => { const k = (n.lane || "main") + "|" + depth[n.id]; (byLaneRow[k] = byLaneRow[k] || []).push(n); });
  for (const k in byLaneRow) {
    const row = byLaneRow[k];
    if (row.length < 2) continue;
    row.sort((a, b) => a.x - b.x);
    for (let i = 1; i < row.length; i++) {
      const need = row[i - 1].x + row[i - 1].w + HGAP;
      if (row[i].x < need) row[i].x = need;
    }
  }

  // 2) spread lanes apart so their content boxes never intersect. The tidy-tree
  //    packs columns tightly, so a wide result/header in one lane overlapped the
  //    neighbouring lane. Repack lanes left->right in order with a fixed gutter.
  const LANE_GAP = 96;
  const laneNodes = {};
  nodes.forEach((n) => { (laneNodes[n.lane] = laneNodes[n.lane] || []).push(n); });
  const order = (model.laneOrder && model.laneOrder.length) ? model.laneOrder.slice() : [];
  for (const k in laneNodes) if (!order.includes(k)) order.push(k);
  let prevMax = -Infinity;
  for (const lid of order) {
    const ns = laneNodes[lid]; if (!ns || !ns.length) continue;
    let lmin = Infinity, lmax = -Infinity;
    ns.forEach((n) => { lmin = Math.min(lmin, n.x); lmax = Math.max(lmax, n.x + n.w); });
    if (isFinite(prevMax) && lmin < prevMax + LANE_GAP) {
      const d = (prevMax + LANE_GAP) - lmin;
      ns.forEach((n) => { n.x += d; });
      lmax += d;
    }
    prevMax = lmax;
  }

  // 3) user-dragged lane offsets, then normalize so nothing sits left of origin
  const lo = model.laneOffset || {};
  let minX = Infinity, maxX = -Infinity, maxY = 0;
  nodes.forEach((n) => {
    const off = lo[n.lane];                            // user-dragged lane position
    if (off) { n.x += off.dx || 0; n.y += off.dy || 0; }
    minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + n.h);
  });
  if (!isFinite(minX)) { minX = 0; maxX = 600; }
  const shift = minX < 0 ? -minX : 0;
  if (shift) nodes.forEach((n) => (n.x += shift));
  return { w: maxX - minX, h: maxY };
}
