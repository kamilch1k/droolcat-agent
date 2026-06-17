// graph.js — the event -> graph reducer + auto-layout.
//
// Takes Claude Code `--output-format stream-json` events and turns each one
// into a graph mutation:
//   system/init            -> the session (orchestrator) root node
//   assistant text         -> live reasoning on the active node
//   assistant tool_use     -> a tool node  (Task -> an agent branch)
//   user    tool_result    -> completes the matching node
//   result                 -> the summary / result node
//
// The model it produces (nodes + edges, each node carrying type/kind/status/
// detail) is exactly what canvas.js renders. Layout positions are computed
// from the tree structure — never hand-placed — so live, arbitrary shapes
// lay out tidily as nodes stream in.

// ---- tool taxonomy -------------------------------------------------------

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
  orch: { w: 224, h: 96 },
  agent: { w: 210, h: 118 },
  tool: { w: 178, h: 86 },
  synth: { w: 160, h: 70 },
  result: { w: 540, h: 220 },
};

// worktree palette — agents get cycled a color/label (real worktree isolation
// is milestone 2; for now a branch is a visual lane).
const WT_PALETTE = [
  { key: "frontend", name: "wt/frontend", color: "var(--wt-frontend)" },
  { key: "api", name: "wt/api", color: "var(--wt-api)" },
  { key: "tests", name: "wt/tests", color: "var(--wt-tests)" },
];
export const WT_MAIN = { key: "main", name: "main", color: "var(--wt-main)" };

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

// short label for what a tool is acting on
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

// flatten the various tool_result content shapes into text
function resultText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b) => (typeof b === "string" ? b : b.text || "")).join("\n");
  }
  return String(content.text || "");
}

// build a unified-diff-ish view from an Edit's input
function diffFromEdit(input) {
  if (!input) return null;
  if (Array.isArray(input.edits)) {
    return input.edits.flatMap((e) => diffPair(e.old_string, e.new_string)).slice(0, 40);
  }
  if (input.old_string != null || input.new_string != null) {
    return diffPair(input.old_string, input.new_string);
  }
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
    this.byToolUse = {};   // tool_use_id -> node
    this.seq = 0;
    this.rootId = null;
    this.lastId = null;    // chain anchor for the next step
    this.frontier = new Set(); // current leaf ids (funnel into the result)
    this.pendingThought = "";  // last assistant text, attached to next tool
    this.wtCursor = 0;
    this.meta = { model: null, cwd: null, tools: 0, sessionId: null };
    this.done = false;
  }

  _add(node) {
    node.id = "n" + this.seq++;
    node.status = node.status || "run";
    node.detail = node.detail || {};
    this.nodes.push(node);
    this.byId[node.id] = node;
    return node;
  }
  _edge(from, to, opts = {}) {
    if (from == null || to == null) return;
    this.edges.push({ from, to, ...opts });
  }
  _root() {
    if (!this.rootId) {
      const r = this._add({
        type: "orch", title: "Session", sub: "claude -p", wt: "main",
        status: "run", thought: "", detail: { think: "", events: [] },
      });
      this.rootId = r.id;
      this.lastId = r.id;
      this.frontier.add(r.id);
    }
    return this.byId[this.rootId];
  }

  // main entry: apply one stream-json event
  apply(evt) {
    if (!evt || typeof evt !== "object") return;
    switch (evt.type) {
      case "system": return this._system(evt);
      case "assistant": return this._assistant(evt);
      case "user": return this._user(evt);
      case "result": return this._result(evt);
    }
  }

  _system(evt) {
    if (evt.subtype && evt.subtype !== "init") return;
    const r = this._root();
    this.meta.model = evt.model || this.meta.model;
    this.meta.cwd = evt.cwd || this.meta.cwd;
    this.meta.tools = (evt.tools || []).length || this.meta.tools;
    this.meta.sessionId = evt.session_id || this.meta.sessionId;
    r.model = this.meta.model;
    r.sub = this.meta.cwd ? tail(this.meta.cwd, 1) : "claude -p";
    r.detail.think = "Session started" + (this.meta.model ? ` on ${this.meta.model}` : "") +
      (this.meta.tools ? ` with ${this.meta.tools} tools.` : ".");
  }

  _assistant(evt) {
    const msg = evt.message || {};
    const content = Array.isArray(msg.content) ? msg.content : [];
    const root = this._root();
    if (msg.model) { this.meta.model = msg.model; root.model = msg.model; }

    // tokens accumulate on the root
    const u = msg.usage || {};
    const tok = (u.input_tokens || 0) + (u.output_tokens || 0) +
      (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    if (tok) root.detail.tokens = fmtTokens((this._tokAcc = (this._tokAcc || 0) + tok));

    // siblings within one message share the parent that was current on entry
    const parent = this.lastId || root.id;
    let lastCreated = null;

    for (const block of content) {
      if (block.type === "text" && block.text && block.text.trim()) {
        const t = block.text.trim();
        this.pendingThought = t;
        root.thought = clip(t, 90);
        root.detail.think = t;
      } else if (block.type === "tool_use") {
        lastCreated = this._toolUse(block, parent);
      }
    }
    if (lastCreated) this.lastId = lastCreated.id;
  }

  _toolUse(block, parent) {
    const name = block.name || "tool";
    const input = block.input || {};
    let node;

    if (name === "Task") {
      const wt = WT_PALETTE[this.wtCursor++ % WT_PALETTE.length];
      node = this._add({
        type: "agent", wt: wt.key, _wt: wt,
        title: clip(input.description || input.subagent_type || "subagent", 22),
        role: (input.subagent_type || "agent"),
        thought: clip(input.prompt || input.description || "", 80),
        status: "run",
        detail: { think: input.prompt || "", input, events: [] },
      });
    } else {
      node = this._add({
        type: "tool", kind: kindOf(name), wt: this._wtOf(parent),
        title: titleOf(name), file: targetOf(name, input),
        thought: clip(this.pendingThought, 64),
        status: "run",
        detail: { input, think: clip(this.pendingThought, 200) },
      });
      this.pendingThought = "";
    }

    this.byToolUse[block.id] = node;
    this._edge(parent, node.id);
    this.frontier.delete(parent);
    this.frontier.add(node.id);
    return node;
  }

  _wtOf(id) {
    const n = this.byId[id];
    return n ? n.wt || "main" : "main";
  }

  _user(evt) {
    const msg = evt.message || {};
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      const node = this.byToolUse[block.tool_use_id];
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
        node.dur = node.dur || null;
        if (isErr) node.donePill = { l: "error", k: "danger" };
      }
    }
  }

  _result(evt) {
    const root = this._root();
    root.status = "done";
    const isErr = evt.is_error === true || evt.subtype === "error";
    const res = this._add({
      type: "result", wt: "main", status: "done",
      title: isErr ? "Failed" : "Result",
      summary: evt.result || (isErr ? "Session ended with an error." : "Session complete."),
      merged: metaLine(evt),
      donePill: isErr ? { l: "error", k: "danger" } : null,
      detail: {
        think: "Collected the session and summarized.",
        model: this.meta.model,
        tokens: usageTokens(evt.usage),
        events: resultEvents(evt),
      },
    });
    // funnel every current leaf into the result
    const leaves = [...this.frontier].filter((id) => id !== res.id);
    (leaves.length ? leaves : [root.id]).forEach((id) => this._edge(id, res.id, { funnel: true }));
    this.frontier = new Set([res.id]);
    this.done = true;
    this.meta.cost = evt.total_cost_usd;
    this.meta.durationMs = evt.duration_ms;
  }

  // counts for the header pill
  stats() {
    let running = 0, agents = 0;
    for (const n of this.nodes) {
      if (n.type === "agent") { agents++; if (n.status === "run") running++; }
    }
    return { running, agents, done: this.done, nodes: this.nodes.length };
  }
}

function clip2(s, n) { // like clip but keeps newlines
  s = String(s == null ? "" : s);
  return s.length > n ? s.slice(0, n - 1) + "\n…" : s;
}
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
  if (evt.num_turns) bits.push(`${evt.num_turns} turns`);
  if (typeof evt.total_cost_usd === "number") bits.push(`$${evt.total_cost_usd.toFixed(3)}`);
  if (evt.duration_ms) bits.push(`${(evt.duration_ms / 1000).toFixed(1)}s`);
  return bits.join(" · ") || "session complete";
}
function usageTokens(u) {
  if (!u) return null;
  return fmtTokens((u.input_tokens || 0) + (u.output_tokens || 0));
}
function resultEvents(evt) {
  const e = [];
  if (evt.duration_ms) e.push([`${(evt.duration_ms / 1000).toFixed(1)}s`, "session duration"]);
  if (evt.num_turns) e.push(["", `${evt.num_turns} model turns`]);
  if (typeof evt.total_cost_usd === "number") e.push(["", `$${evt.total_cost_usd.toFixed(4)} billed`]);
  return e;
}

// ---- auto-layout (tidy tree over the primary-parent spanning tree) -------

export function layout(model) {
  const { nodes, edges } = model;
  if (!nodes.length) return { w: 0, h: 0 };

  const childrenOf = {}, primaryParent = {}, incoming = {};
  nodes.forEach((n) => (childrenOf[n.id] = []));
  // first incoming edge that isn't a funnel-to-result is the layout parent
  edges.forEach((e) => {
    const child = model.byId[e.to];
    if (child && child.type === "result") return; // result is placed manually
    if (incoming[e.to] == null) incoming[e.to] = e.from;
  });
  nodes.forEach((n) => {
    const p = incoming[n.id];
    if (p != null && childrenOf[p] && n.type !== "result") {
      primaryParent[n.id] = p;
      childrenOf[p].push(n.id);
    }
  });

  // depth = longest path over ALL edges, so the result sinks below everything
  const depth = {};
  nodes.forEach((n) => (depth[n.id] = 0));
  for (let i = 0; i < nodes.length + 2; i++) {
    let changed = false;
    edges.forEach((e) => {
      if (depth[e.to] < depth[e.from] + 1) { depth[e.to] = depth[e.from] + 1; changed = true; }
    });
    if (!changed) break;
  }

  const roots = nodes.filter((n) => n.type !== "result" && primaryParent[n.id] == null).map((n) => n.id);
  const COL = 250, ROW = 152;
  const x = {};
  let cursor = 0;
  const place = (id) => {
    const kids = childrenOf[id];
    if (!kids.length) { x[id] = cursor; cursor += COL; return; }
    kids.forEach(place);
    x[id] = (x[kids[0]] + x[kids[kids.length - 1]]) / 2;
  };
  roots.forEach(place);

  let minX = Infinity, maxX = -Infinity, maxY = 0;
  nodes.forEach((n) => {
    const sz = SIZES[n.type] || SIZES.tool;
    n.w = sz.w; n.h = sz.h;
    if (n.type === "result") return;
    n.x = (x[n.id] || 0) + COL / 2 - n.w / 2;
    n.y = depth[n.id] * ROW;
    minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x + n.w);
    maxY = Math.max(maxY, n.y + n.h);
  });
  if (!isFinite(minX)) { minX = 0; maxX = 600; }

  // place the result centered under the graph
  const result = nodes.find((n) => n.type === "result");
  if (result) {
    result.x = (minX + maxX) / 2 - result.w / 2;
    result.y = (depth[result.id] || Math.round(maxY / ROW)) * ROW;
    maxY = Math.max(maxY, result.y + result.h);
    minX = Math.min(minX, result.x); maxX = Math.max(maxX, result.x + result.w);
  }

  // normalize so the graph starts near origin
  const shift = minX < 0 ? -minX : 0;
  if (shift) nodes.forEach((n) => (n.x += shift));
  return { w: maxX - minX, h: maxY };
}
