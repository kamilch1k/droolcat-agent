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
  agent: { w: 196, h: 104 },
  tool: { w: 168, h: 74 },
  result: { w: 440, h: 176 },
};

// subagents (Task) get a cycling accent so parallel branches read distinctly
const SUB_PALETTE = ["var(--wt-frontend)", "var(--wt-api)", "var(--wt-tests)", "#b6478f", "#3a86c8"];

function kindOf(tool) { return KIND_BY_TOOL[tool] || "read"; }
function titleOf(tool) { return TITLE_BY_TOOL[tool] || tool.toLowerCase(); }
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
    this.lastResultId = null;   // tail of the conversation — next turn chains here
    this.turn = null;           // current turn's cursor
    this.turnCount = 0;
    this.running = false;
    this.subCount = 0;
  }

  _add(node) {
    node.id = "n" + this.seq++;
    node.status = node.status || "run";
    node.detail = node.detail || {};
    if (!node.wt) node.wt = "main";
    this.nodes.push(node);
    this.byId[node.id] = node;
    return node;
  }
  _edge(from, to, opts = {}) {
    if (from == null || to == null) return;
    this.edges.push({ from, to, ...opts });
  }

  // start a new turn from a user prompt — appended, never resetting
  beginTurn(prompt) {
    // close any still-open turn so the chain stays well-formed
    if (this.turn && !this.turn.resultId) this.endTurn(true);
    this.turnCount++;
    const p = this._add({
      type: "prompt", title: "You", text: prompt, turn: this.turnCount,
      status: "done", detail: {},
    });
    if (this.lastResultId) this._edge(this.lastResultId, p.id, { turn: true });
    this.turn = { anchorId: p.id, lastId: p.id, byToolUse: {}, frontier: new Set([p.id]), tokAcc: 0, resultId: null, streamSay: null, streamBlocks: {}, usedPartials: false };
    this.running = true;
    return p;
  }

  apply(evt) {
    if (!evt || typeof evt !== "object") return;
    if (!this.turn) this.beginTurn("(session)");
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
      }
    } else if (ev.type === "content_block_stop") {
      const blk = t.streamBlocks[ev.index];
      if (blk && blk.type === "text" && blk.node) { blk.node.status = "done"; if (t.streamSay === blk.node) t.streamSay = null; }
    }
  }

  _system(evt) {
    if (evt.subtype && evt.subtype !== "init") return;
    this.meta.model = evt.model || this.meta.model;
    this.meta.cwd = evt.cwd || this.meta.cwd;
    this.meta.sessionId = evt.session_id || this.meta.sessionId;
    const p = this.byId[this.turn.anchorId];
    if (p && evt.model) p.model = evt.model;
  }

  _assistant(evt) {
    const t = this.turn;
    const msg = evt.message || {};
    const content = Array.isArray(msg.content) ? msg.content : [];
    if (msg.model) this.meta.model = msg.model;
    const u = msg.usage || {};
    const tok = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    if (tok) t.tokAcc += tok;

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
      if (block.type === "text" && block.text && block.text.trim()) {
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
        const diff = node.kind === "edit" ? diffFromEdit(node.detail.input) : null;
        if (diff && diff.length) node.detail.diff = diff;
        else node.detail.out = clip2(out, 1600);
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
    this.lastResultId = res.id;
    this.running = false;
  }

  // stream ended (claude-end) — if no result event arrived, synthesize one so
  // the turn closes and the next prompt has something to chain from
  endTurn(ok) {
    const t = this.turn;
    if (t && !t.resultId) {
      this._result({ result: ok ? "Done." : "The session ended.", is_error: !ok });
    }
    this.running = false;
  }

  stats() {
    let running = 0;
    for (const n of this.nodes) if ((n.type === "tool" || n.type === "agent") && n.status === "run") running++;
    return { running, busy: this.running, turns: this.turnCount, done: !this.running, nodes: this.nodes.length };
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
  const COL = 212, VGAP = 40;
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
    const h = (SIZES[n.type] || SIZES.tool).h;
    const d = depth[n.id];
    rowH[d] = Math.max(rowH[d] || 0, h);
    maxDepth = Math.max(maxDepth, d);
  });
  const yOf = {};
  let acc = 0;
  for (let d = 0; d <= maxDepth; d++) { yOf[d] = acc; acc += (rowH[d] || SIZES.tool.h) + VGAP; }

  let minX = Infinity, maxX = -Infinity, maxY = 0;
  nodes.forEach((n) => {
    const sz = SIZES[n.type] || SIZES.tool;
    n.w = sz.w; n.h = sz.h;
    n.x = (x[n.id] || 0) + COL / 2 - n.w / 2;
    n.y = yOf[depth[n.id]] || 0;
    minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + n.h);
  });
  if (!isFinite(minX)) { minX = 0; maxX = 600; }
  const shift = minX < 0 ? -minX : 0;
  if (shift) nodes.forEach((n) => (n.x += shift));
  return { w: maxX - minX, h: maxY };
}
