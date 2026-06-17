// graph.js — the event -> graph reducer + auto-layout.
//
// Milestone 2: the model is multi-LANE. Each lane (keyed by agentId) is its own
// driven `claude -p` session — its tool calls chain under its own branch node,
// and all lanes funnel into one result. The flat single-session loop is the
// N=1 case (one lane "main" anchored directly on the orchestrator root), so the
// reducer has a single code path.
//
//   orchestration-start -> beginOrchestration() pre-draws orch + agent lanes
//   stream events        -> apply(evt, agentId) grows that lane's subtree
//   claude-end (per lane) -> endAgent() marks the lane done
//   orchestration-end    -> finishOrchestration() funnels every lane -> result
//   merge-result         -> applyMerge() annotates the result node
//
// Bare events with no orchestration (the legacy sample / shim path) run as the
// "main" lane and create the result node directly on the `result` event.

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

export const WT_MAIN = { key: "main", name: "main", color: "var(--wt-main)" };
// lane colors assigned deterministically by lane index (cap 4 lanes)
const LANE_PALETTE = ["var(--wt-frontend)", "var(--wt-api)", "var(--wt-tests)", "#b6478f"];
const laneName = (key) => (key === "main" ? "main" : `wt/${key}`);

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
    this.rootId = null;
    this.resultId = null;
    this.lanes = {};                 // agentId -> { rootId, lastId, byToolUse, frontier, pendingThought, wt, tokAcc }
    this.wtMap = { main: { name: "main", color: "var(--wt-main)" } };
    this.meta = { model: null, cwd: null, sessionId: null };
    this.base = null; this.baseBranch = null; this.isGit = false;
    this.orchestrated = false;       // true once orchestration-start seen
    this.multi = false;              // true when >1 real lane
    this.done = false;
    this._costAcc = 0;
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
      const r = this._add({ type: "orch", title: "Orchestrator", sub: "claude -p", wt: "main", status: "run", thought: "", detail: { think: "", events: [] } });
      this.rootId = r.id;
    }
    return this.byId[this.rootId];
  }

  _newLane(agentId, anchorId, wt) {
    const lane = { rootId: anchorId, lastId: anchorId, byToolUse: {}, frontier: new Set([anchorId]), pendingThought: "", wt: wt || "main", tokAcc: 0 };
    this.lanes[agentId] = lane;
    return lane;
  }
  _lane(agentId) {
    let lane = this.lanes[agentId];
    if (!lane) {
      const root = this._root();          // flat / sample path: main lane == orchestrator root
      lane = this._newLane(agentId, root.id, "main");
    }
    return lane;
  }

  // orchestration-start: pre-draw the orchestrator + a pending node per lane
  beginOrchestration({ base, baseBranch, isGit, lanes } = {}) {
    const root = this._root();
    this.orchestrated = true;
    this.base = base; this.baseBranch = baseBranch; this.isGit = !!isGit;
    const arr = lanes || [];
    this.multi = arr.length > 1;

    if (arr.length === 1 && arr[0].agentId === "main") {
      this._newLane("main", root.id, "main");
      root.sub = isGit ? tail(this.meta.cwd || "", 1) || "claude -p" : "claude -p";
      return;
    }
    root.sub = `${arr.length} lanes`;
    arr.forEach((l, i) => {
      const key = l.agentId;
      const color = LANE_PALETTE[i % LANE_PALETTE.length];
      this.wtMap[key] = { name: l.wt && l.wt !== key ? l.wt : laneName(key), color };
      const node = this._add({
        type: "agent", wt: key,
        title: clip(l.title || key, 22), role: l.branch ? tail(l.branch, 2) : "lane",
        thought: "", status: "pend",
        detail: { think: "", events: [], branch: l.branch, wtDir: l.wtDir },
      });
      this._edge(root.id, node.id);
      this._newLane(key, node.id, key);
    });
  }

  // main entry: apply one stream-json event for a given lane
  apply(evt, agentId = "main") {
    if (!evt || typeof evt !== "object") return;
    switch (evt.type) {
      case "system": return this._system(evt, agentId);
      case "assistant": return this._assistant(evt, agentId);
      case "user": return this._user(evt, agentId);
      case "result": return this._result(evt, agentId);
    }
  }

  _system(evt, agentId) {
    if (evt.subtype && evt.subtype !== "init") return;
    const lane = this._lane(agentId);
    const node = this.byId[lane.rootId];
    this.meta.model = evt.model || this.meta.model;
    this.meta.cwd = evt.cwd || this.meta.cwd;
    this.meta.sessionId = evt.session_id || this.meta.sessionId;
    if (node) {
      node.model = evt.model || node.model;
      node.detail.think = "Session started" + (evt.model ? ` on ${evt.model}` : "") +
        ((evt.tools || []).length ? ` with ${evt.tools.length} tools.` : ".");
      if (node.type === "orch" && this.meta.cwd) node.sub = tail(this.meta.cwd, 1);
    }
  }

  _assistant(evt, agentId) {
    const lane = this._lane(agentId);
    const node = this.byId[lane.rootId];
    if (node && node.status === "pend") node.status = "run";
    const msg = evt.message || {};
    const content = Array.isArray(msg.content) ? msg.content : [];
    if (msg.model) { this.meta.model = msg.model; if (node) node.model = msg.model; }

    const u = msg.usage || {};
    const tok = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    if (tok && node) { lane.tokAcc += tok; node.detail.tokens = fmtTokens(lane.tokAcc); }

    const parent = lane.lastId;
    let lastCreated = null;
    for (const block of content) {
      if (block.type === "text" && block.text && block.text.trim()) {
        const t = block.text.trim();
        lane.pendingThought = t;
        if (node) { node.thought = clip(t, 90); node.detail.think = t; }
      } else if (block.type === "tool_use") {
        lastCreated = this._toolUse(block, agentId, parent);
      }
    }
    if (lastCreated) lane.lastId = lastCreated.id;
  }

  _toolUse(block, agentId, parent) {
    const lane = this._lane(agentId);
    const name = block.name || "tool";
    const input = block.input || {};
    let node;
    if (name === "Task") {
      node = this._add({
        type: "agent", wt: lane.wt,
        title: clip(input.description || input.subagent_type || "subagent", 22),
        role: input.subagent_type || "agent",
        thought: clip(input.prompt || input.description || "", 80), status: "run",
        detail: { think: input.prompt || "", input, events: [] },
      });
    } else {
      node = this._add({
        type: "tool", kind: kindOf(name), wt: lane.wt,
        title: titleOf(name), file: targetOf(name, input),
        thought: clip(lane.pendingThought, 64), status: "run",
        detail: { input, think: clip(lane.pendingThought, 200) },
      });
      lane.pendingThought = "";
    }
    lane.byToolUse[block.id] = node;
    this._edge(parent, node.id);
    lane.frontier.delete(parent);
    lane.frontier.add(node.id);
    return node;
  }

  _user(evt, agentId) {
    const lane = this._lane(agentId);
    const content = Array.isArray(evt.message?.content) ? evt.message.content : [];
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      const node = lane.byToolUse[block.tool_use_id];
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
      }
    }
  }

  _result(evt, agentId) {
    const lane = this._lane(agentId);
    const isErr = evt.is_error === true || evt.subtype === "error";
    if (typeof evt.total_cost_usd === "number") this._costAcc += evt.total_cost_usd;

    if (!this.orchestrated) {
      // legacy / bare-sample path — create the single result node now
      return this._makeResult(evt, isErr, [lane]);
    }
    // orchestrated: mark this lane's branch node done; result waits for orchestration-end
    const node = this.byId[lane.rootId];
    if (node) {
      if (node.type === "agent") {
        node.status = "done";
        node.detail.out = clip2(evt.result || "", 1200);
        if (evt.duration_ms) node.dur = (evt.duration_ms / 1000).toFixed(1) + "s";
        if (isErr) node.donePill = { l: "error", k: "danger" };
        else node.donePill = { l: "done", k: "success" };
        const t = usageTokens(evt.usage); if (t) node.detail.tokens = t;
      } else {
        node.status = "done"; // orchestrator root for the flat "main" lane
        node._summary = evt.result;
      }
    }
  }

  // per-lane process end (covers lanes that exit without a `result` event)
  endAgent({ agentId, ok, commit }) {
    const lane = this.lanes[agentId];
    if (!lane) return;
    const node = this.byId[lane.rootId];
    if (node) {
      if (node.status !== "done") {
        node.status = "done";
        if (!node.donePill) node.donePill = ok ? { l: "done", k: "success" } : { l: "exited", k: "danger" };
      }
      if (commit) node.detail.commit = commit;
    }
  }

  // orchestration-end: build the single result node, funnel every lane into it
  finishOrchestration(evt = {}) {
    if (this.resultId) return;
    const lanes = Object.values(this.lanes);
    this._makeResult(evt.summaryEvt || {}, evt.ok === false, lanes);
  }

  _makeResult(evt, isErr, lanes) {
    const root = this._root();
    root.status = "done";
    const summary = evt.result || root._summary ||
      (this.multi ? `Orchestration complete — ${lanes.length} lanes.` : "Session complete.");
    const res = this._add({
      type: "result", wt: "main", status: "done",
      title: isErr ? "Failed" : "Result",
      summary,
      merged: this.isGit ? "ready to merge" : metaLine(evt),
      donePill: isErr ? { l: "error", k: "danger" } : null,
      detail: {
        think: this.multi ? "Collected all lanes and prepared merge-back." : "Collected the session and summarized.",
        model: this.meta.model,
        tokens: this._costAcc ? `$${this._costAcc.toFixed(3)}` : usageTokens(evt.usage),
        events: resultEvents(evt),
      },
    });
    this.resultId = res.id;
    const leaves = new Set();
    lanes.forEach((ln) => ln.frontier.forEach((id) => id !== res.id && leaves.add(id)));
    (leaves.size ? [...leaves] : [root.id]).forEach((id) => this._edge(id, res.id, { funnel: true }));
    this.done = true;
  }

  // merge-result: annotate the result node with the merge outcome
  applyMerge(report) {
    const res = this.byId[this.resultId];
    if (!res || !report) return;
    const r = report.results || [];
    const merged = r.filter((x) => x.status === "merged").length;
    const empty = r.filter((x) => x.status === "empty").length;
    const conflicts = r.filter((x) => x.status === "conflict");
    const parts = [];
    if (merged) parts.push(`${merged} merged`);
    if (empty) parts.push(`${empty} empty`);
    if (conflicts.length) parts.push(`${conflicts.length} conflict (${conflicts.flatMap((c) => c.conflicts).slice(0, 2).join(", ")})`);
    res.merged = parts.join(" · ") || "nothing to merge";
    res.detail.mergeReport = report;
    if (conflicts.length) res.donePill = { l: "conflict", k: "danger" };
    else if (report.ok) res.donePill = { l: "merged", k: "success" };
    // paint conflicted lanes red
    conflicts.forEach((c) => {
      const lane = this.lanes[c.agentId];
      const node = lane && this.byId[lane.rootId];
      if (node) node.donePill = { l: "conflict", k: "danger" };
    });
  }

  stats() {
    let running = 0, agents = 0;
    for (const n of this.nodes) {
      if (n.type === "agent") { agents++; if (n.status === "run") running++; }
    }
    return { running, agents, done: this.done, nodes: this.nodes.length };
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
  if (evt.num_turns) bits.push(`${evt.num_turns} turns`);
  if (typeof evt.total_cost_usd === "number") bits.push(`$${evt.total_cost_usd.toFixed(3)}`);
  if (evt.duration_ms) bits.push(`${(evt.duration_ms / 1000).toFixed(1)}s`);
  return bits.join(" · ") || "session complete";
}
function usageTokens(u) { if (!u) return null; return fmtTokens((u.input_tokens || 0) + (u.output_tokens || 0)); }
function resultEvents(evt) {
  const e = [];
  if (evt.duration_ms) e.push([`${(evt.duration_ms / 1000).toFixed(1)}s`, "session duration"]);
  if (evt.num_turns) e.push(["", `${evt.num_turns} model turns`]);
  if (typeof evt.total_cost_usd === "number") e.push(["", `$${evt.total_cost_usd.toFixed(4)} billed`]);
  return e;
}

// ---- auto-layout (tidy tree over the primary-parent spanning tree) -------
// Unchanged from M1: multiple agent subtrees under one orch root lay out as
// parallel columns for free; N=1 is identical to the flat loop.

export function layout(model) {
  const { nodes, edges } = model;
  if (!nodes.length) return { w: 0, h: 0 };

  const childrenOf = {}, primaryParent = {}, incoming = {};
  nodes.forEach((n) => (childrenOf[n.id] = []));
  edges.forEach((e) => {
    const child = model.byId[e.to];
    if (child && child.type === "result") return;
    if (incoming[e.to] == null) incoming[e.to] = e.from;
  });
  nodes.forEach((n) => {
    const p = incoming[n.id];
    if (p != null && childrenOf[p] && n.type !== "result") {
      primaryParent[n.id] = p;
      childrenOf[p].push(n.id);
    }
  });

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

  const result = nodes.find((n) => n.type === "result");
  if (result) {
    result.x = (minX + maxX) / 2 - result.w / 2;
    result.y = (depth[result.id] || Math.round(maxY / ROW)) * ROW;
    maxY = Math.max(maxY, result.y + result.h);
    minX = Math.min(minX, result.x); maxX = Math.max(maxX, result.x + result.w);
  }

  const shift = minX < 0 ? -minX : 0;
  if (shift) nodes.forEach((n) => (n.x += shift));
  return { w: maxX - minX, h: maxY };
}
