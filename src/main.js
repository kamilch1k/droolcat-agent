// main.js — app wiring: sources (live bridge / sample replay) -> reducer -> canvas.
// Milestone 2: handles the enveloped multi-lane protocol on both the live bridge
// and the offline replayer, plus the parallel-orchestration trigger + merge-back.
import "./styles.css";
import { I } from "./icons.js";
import { GraphModel, layout } from "./graph.js";
import { Canvas } from "./canvas.js";

const $ = (id) => document.getElementById(id);

$("ic-plus").innerHTML = I.plus;
$("ic-up").innerHTML = I.up;
$("ic-play").innerHTML = I.play;
$("ic-empty").innerHTML = I.graph;

const model = new GraphModel();
const canvas = new Canvas(
  {
    world: $("world"), edges: $("edges"), viewport: $("viewport"),
    inspector: $("inspector"), inwrap: $("inwrap"), headpill: $("headpill"),
    target: $("target"), empty: $("empty"), zl: $("zl"),
  },
  { onSteer: (node, text) => sendPrompt(text, node), onMerge: onMerge, onOpenWorktree: onOpenWorktree }
);
canvas.setModel(model);

let source = "live";          // 'live' | 'sample'
let fixture = "flat";          // 'flat' | 'parallel' (sample mode)
let parallel = false;          // live parallel-orchestration mode
let rawEvents = [];            // captured lines of the current session (for replay)
let tauri = null;
let autoFit = true;
let syncQueued = false;
let mergePreviewed = false;

// the current live orchestration (for merge / cleanup / stop)
let live = { sessionId: null, cwd: null, baseBranch: null, lanes: [] };
// canned merge-result from a parallel sample fixture (fired on merge click)
let sampleMerge = null;

// ---- Tauri detection + bridge wiring ------------------------------------

async function getTauri() {
  if (tauri) return tauri;
  if (!window.__TAURI_INTERNALS__) return null;
  const core = await import("@tauri-apps/api/core");
  const event = await import("@tauri-apps/api/event");
  tauri = { invoke: core.invoke, listen: event.listen };
  return tauri;
}

async function wireBridge() {
  const t = await getTauri();
  if (!t) { setConn("", "browser (sample only)"); setSource("sample", "flat"); disableLive(); return; }
  setConn("live", "bridge ready");
  await t.listen("orchestration-start", (e) => { beginOrch(e.payload); });
  await t.listen("claude-event", (e) => { handleEvent(e.payload); });
  await t.listen("claude-end", (e) => { model.endAgent(e.payload || {}); schedule(); });
  await t.listen("orchestration-end", (e) => { finishOrch(e.payload || {}); });
  await t.listen("merge-result", (e) => { model.applyMerge(e.payload); schedule(); });
  await t.listen("claude-stderr", (e) => console.warn("[stderr]", e.payload?.agentId || "", e.payload?.line || e.payload));
}

function disableLive() {
  const btn = document.querySelector('.srcsel button[data-src="live"]');
  if (btn) { btn.disabled = true; btn.title = "Live bridge runs in the desktop app (npm run app)"; btn.style.opacity = .45; }
  $("parallel").style.display = "none";
}

// ---- event handlers (shared by live listeners + sample replayer) --------

function beginOrch(p) {
  if (!p) return;
  model.beginOrchestration(p);
  // remember refs for merge / cleanup
  live.sessionId = p.sessionId || live.sessionId;
  live.baseBranch = p.baseBranch || "";
  live.lanes = (p.lanes || []).map((l) => ({ agent_id: l.agentId, key: l.wt || l.agentId, branch: l.branch || "", wt_dir: l.wtDir || "" }));
  $("stopall").style.display = (p.lanes && p.lanes.length && source === "live") ? "" : "none";
  renderWts();
  schedule();
}
function handleEvent(env) {
  if (!env) return;
  rawEvents.push(env);
  model.apply(env.evt, env.agentId || "main");
  schedule();
}
function finishOrch(p) {
  model.finishOrchestration({ ok: p && p.ok !== false });
  $("stopall").style.display = "none";
  setConn(tauri && source === "live" ? "live" : "", source === "live" ? "session complete" : "sample · done");
  schedule();
}

// ---- one event in -> reduce -> schedule a render ------------------------

function schedule() {
  layout(model);
  if (syncQueued) return;
  syncQueued = true;
  const run = () => {
    if (!syncQueued) return;
    syncQueued = false;
    canvas.sync();
    renderWts();
    if (autoFit) canvas.fit();
  };
  requestAnimationFrame(run);
  setTimeout(run, 120);
}

// ---- prompt + sources ---------------------------------------------------

async function sendPrompt(text, steerNode) {
  if (source === "sample") { replaySample(); return; }
  text = (text || "").trim();
  if (!text) return;

  const t = await getTauri();
  if (!t) { setConn("err", "no bridge — switch to sample"); return; }

  if (parallel) return startParallel(text, t);

  // flat single-session loop
  resetSession();
  $("sesstitle").textContent = clip(text, 40);
  setConn("run", "running claude…");
  try {
    await t.invoke("start_session", { prompt: text, steer: steerNode ? steerNode.title : null });
  } catch (err) { setConn("err", String(err)); }
}

// auto-plan -> editable confirm -> start_orchestration
async function startParallel(text, t) {
  const cwd = $("repo").value.trim();
  if (!cwd) { setConn("err", "set a git repo path for parallel mode"); $("repo").focus(); return; }
  setConn("run", "planning lanes…");
  let plan;
  try { plan = await t.invoke("plan_lanes", { cwd, prompt: text }); }
  catch (err) { setConn("err", String(err)); return; }
  setConn("live", plan.is_git ? `${plan.lanes.length} lane(s) planned` : "not a git repo — single lane");
  showLaneConfirm(plan, cwd, text, t);
}

function showLaneConfirm(plan, cwd, prompt, t) {
  canvas.selected = null;
  $("inspector").classList.add("open");
  const lines = plan.lanes.map((l) => `${l.key} | ${l.title} | ${l.prompt}`).join("\n");
  $("inwrap").innerHTML = `
    <div class="crumb">parallel orchestration</div>
    <div class="inh">Review lanes</div>
    <div class="lead">Each lane runs as its own claude in its own git worktree off the current HEAD, then you merge back. Edit below — one lane per line as <code>key | title | prompt</code>.</div>
    <div class="blk lanesform">
      <textarea id="laneedit">${lines.replace(/</g, "&lt;")}</textarea>
      <div class="acts">
        <button class="btn" id="lanecancel">cancel</button>
        <button class="btn primary" id="lanerun">run lanes ↗</button>
      </div>
    </div>`;
  $("lanecancel").onclick = () => { $("inspector").classList.remove("open"); setConn("live", "bridge ready"); };
  $("lanerun").onclick = async () => {
    const lanes = parseLanes($("laneedit").value, prompt);
    if (!lanes.length) return;
    $("inspector").classList.remove("open");
    resetSession();
    $("sesstitle").textContent = `parallel · ${clip(prompt, 30)}`;
    live.cwd = cwd;
    const sessionId = "orch-" + Date.now().toString(36);
    setConn("run", `orchestrating ${lanes.length} lanes…`);
    try {
      await t.invoke("start_orchestration", { sessionId, cwd, lanes, opts: { budget_usd: null, yolo: false } });
    } catch (err) { setConn("err", String(err)); }
  };
}

function parseLanes(text, fallbackPrompt) {
  const lanes = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split("|").map((s) => s.trim());
    const key = (parts[0] || "lane").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "") || "lane";
    const title = parts[1] || key;
    const prompt = parts.slice(2).join(" | ") || parts[1] || fallbackPrompt;
    lanes.push({ key, title, prompt });
  }
  return lanes.slice(0, 4);
}

function resetSession() {
  model.reset(); rawEvents = []; mergePreviewed = false; sampleMerge = null;
  live = { sessionId: null, cwd: $("repo").value.trim() || null, baseBranch: null, lanes: [] };
  autoFit = true; canvas.deselect(); canvas.sync();
}

// ---- merge + stop + open-worktree ---------------------------------------

async function onMerge(resultNode) {
  if (source === "sample") {
    if (sampleMerge) { model.applyMerge(sampleMerge); schedule(); }
    return;
  }
  const t = await getTauri(); if (!t) return;
  const apply = mergePreviewed;
  setConn("run", apply ? "merging…" : "merge preview…");
  try {
    await t.invoke("merge_lanes", { cwd: live.cwd, baseBranch: live.baseBranch, lanes: live.lanes, apply });
    mergePreviewed = !apply ? true : false;
    setConn("live", apply ? "merged" : "preview — click merge again to apply");
    if (apply) { try { await t.invoke("cleanup_session", { cwd: live.cwd, sessionId: live.sessionId, lanes: live.lanes }); } catch {} }
  } catch (err) { setConn("err", String(err)); }
}

async function onOpenWorktree(node) {
  if (source !== "live") return;
  const t = await getTauri(); if (!t) return;
  try { await t.invoke("open_worktree", { cwd: live.cwd, sessionId: live.sessionId, key: node.wt }); } catch (err) { console.warn(err); }
}

async function stopAll() {
  const t = await getTauri(); if (!t || !live.sessionId) return;
  try { await t.invoke("stop_all", { sessionId: live.sessionId }); setConn("live", "stopped"); } catch (err) { console.warn(err); }
}

// ---- sample replay (flat bare events OR parallel envelope fixture) -------

async function replaySample() {
  const file = fixture === "parallel" ? "sample-orchestration.jsonl" : "sample-session.jsonl";
  const lines = await loadSample(file);
  if (!lines.length) return;
  resetSession();
  $("sesstitle").textContent = fixture === "parallel" ? "Sample · parallel auth" : "Sample · auth refactor";
  setConn("run", "replaying sample…");
  let i = 0;
  const step = () => {
    if (i >= lines.length) { setConn("", "sample · done"); return; }
    const line = lines[i++];
    dispatchSample(line);
    const gap = (line.kind === "orchestration-end" || line.evt?.type === "result" || line.type === "result") ? 80 : 320;
    setTimeout(step, gap);
  };
  step();
}

function dispatchSample(line) {
  if (line.kind === "orchestration-start") beginOrch(line);
  else if (line.kind === "event") handleEvent(line);
  else if (line.kind === "end") { model.endAgent(line); schedule(); }
  else if (line.kind === "orchestration-end") finishOrch(line);
  else if (line.kind === "merge-result") { sampleMerge = line; } // fired on merge click
  else { model.apply(line, "main"); schedule(); }              // bare legacy event
}

const _sampleCache = {};
async function loadSample(file) {
  if (_sampleCache[file]) return _sampleCache[file];
  try {
    const r = await fetch("/samples/" + file);
    const text = await r.text();
    _sampleCache[file] = text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
  } catch (err) { console.error("sample load failed", err); _sampleCache[file] = []; }
  return _sampleCache[file];
}

function setSource(s, fx) {
  source = s;
  if (fx) fixture = fx;
  document.querySelectorAll(".srcsel button").forEach((b) =>
    b.classList.toggle("active", b.dataset.src === s && (s !== "sample" || b.dataset.fixture === fixture)));
  $("repo").style.display = (s === "live" && parallel) ? "" : "none";
}

// ---- sidebar ------------------------------------------------------------

function renderWts() {
  const h = $("wtlist");
  h.innerHTML = "";
  const keys = Object.keys(model.wtMap);
  if (!model.nodes.length) { h.innerHTML = `<div class="empty-side">No active worktrees yet.</div>`; return; }
  const statusByWt = {};
  for (const n of model.nodes) if (n.type === "agent") statusByWt[n.wt] = n.status;
  for (const key of keys) {
    const w = model.wtMap[key];
    const st = statusByWt[key];
    const git = key === "main" ? "base" : st === "run" ? "running" : st === "done" ? "ready" : "queued";
    const d = document.createElement("div");
    d.className = "wtrow" + (canvas.selWt === key ? " sel" : "");
    d.innerHTML = `<span class="sw" style="background:${w.color}"></span><div><div class="nm">${w.name}</div><div class="git">${git}</div></div>`;
    d.onclick = () => { canvas.setWtFilter(key); renderWts(); };
    h.appendChild(d);
  }
}

function renderSessions() {
  $("sesslist").innerHTML =
    `<div class="sessrow active"><span class="aw-ic">${I.branch}</span><span class="t">current</span><span class="dot" style="background:var(--color-text-info)"></span></div>`;
}

function setConn(cls, label) {
  const el = $("conn");
  el.className = "conn" + (cls ? " " + cls : "");
  el.textContent = label;
}
function clip(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; }

// ---- toolbar / prompt events --------------------------------------------

document.querySelectorAll(".srcsel button").forEach((b) =>
  b.onclick = () => { if (!b.disabled) setSource(b.dataset.src, b.dataset.fixture || fixture); });
$("send").onclick = () => fireSend();
$("prompt").addEventListener("keydown", (e) => { if (e.key === "Enter") fireSend(); });
function fireSend() {
  const i = $("prompt"), v = i.value.trim();
  if (!v && source !== "sample") return;
  i.value = "";
  sendPrompt(v);
}
$("parallel").onclick = () => {
  parallel = !parallel;
  $("parallel").classList.toggle("active", parallel);
  $("parallel").textContent = parallel ? "⚡ parallel" : "single";
  $("repo").style.display = (source === "live" && parallel) ? "" : "none";
};
$("stopall").onclick = stopAll;
$("newsession").onclick = () => { resetSession(); renderWts(); $("sesstitle").textContent = "No session"; setConn(tauri ? "live" : "", tauri ? "bridge ready" : "browser (sample only)"); };
$("zin").onclick = () => { autoFit = false; canvas.zoom(1.15); };
$("zout").onclick = () => { autoFit = false; canvas.zoom(1 / 1.15); };
$("fit").onclick = () => canvas.fit();
$("replay").onclick = () => {
  if (source === "sample") return replaySample();
  if (rawEvents.length) {
    const evs = rawEvents.slice();
    model.reset(); rawEvents = []; canvas.sync();
    let i = 0; const step = () => { if (i >= evs.length) return; handleEvent(evs[i++]); setTimeout(step, 300); }; step();
  } else replaySample();
};
$("viewport").addEventListener("mousedown", () => { autoFit = false; });

// ---- boot ---------------------------------------------------------------

renderSessions();
renderWts();
wireBridge();
