// main.js — app wiring: sources (live bridge / sample replay) -> reducer -> canvas.
import "./styles.css";
import { I } from "./icons.js";
import { GraphModel, layout } from "./graph.js";
import { Canvas } from "./canvas.js";

const $ = (id) => document.getElementById(id);

// paint the static icons
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
  { onSteer: (node, text) => sendPrompt(text, node) }
);
canvas.setModel(model);

let source = "live";        // 'live' | 'sample'
let rawEvents = [];          // captured events of the current session (for replay)
let tauri = null;            // { invoke, listen } when running under Tauri
let autoFit = true;          // follow the graph until the user interacts
let syncQueued = false;

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
  if (!t) { setConn("", "browser (sample only)"); setSource("sample"); disableLive(); return; }
  setConn("live", "bridge ready");
  await t.listen("claude-event", (e) => ingest(e.payload));
  await t.listen("claude-end", (e) => {
    setConn("live", e.payload && e.payload.ok ? "session complete" : "session ended");
  });
  await t.listen("claude-error", (e) => setConn("err", String(e.payload || "error")));
  await t.listen("claude-stderr", (e) => console.warn("[claude stderr]", e.payload));
}

function disableLive() {
  const btn = document.querySelector('.srcsel button[data-src="live"]');
  if (btn) { btn.disabled = true; btn.title = "Live bridge runs in the desktop app (npm run app)"; btn.style.opacity = .45; }
}

// ---- one event in -> reduce -> schedule a render ------------------------

function ingest(evt) {
  if (typeof evt === "string") { try { evt = JSON.parse(evt); } catch { return; } }
  rawEvents.push(evt);
  model.apply(evt);
  layout(model);
  scheduleSync();
}

function scheduleSync() {
  if (syncQueued) return;
  syncQueued = true;
  const run = () => {
    if (!syncQueued) return; // already ran via the other path
    syncQueued = false;
    canvas.sync();
    renderWts();
    if (autoFit) canvas.fit();
  };
  // rAF batches bursts on a visible window; the timeout is a fallback for when
  // the window is backgrounded (rAF throttled to never).
  requestAnimationFrame(run);
  setTimeout(run, 120);
}

// ---- prompt + sources ---------------------------------------------------

async function sendPrompt(text, steerNode) {
  // sample mode ignores prompt content — it replays the captured transcript
  if (source === "sample") { replaySample(); return; }

  text = (text || "").trim();
  if (!text) return;

  const t = await getTauri();
  if (!t) { setConn("err", "no bridge — switch to sample"); return; }

  // fresh turn (steering reuse / multi-turn branching is milestone 2)
  model.reset(); rawEvents = []; canvas.sync();
  $("sesstitle").textContent = clip(text, 40);
  autoFit = true;
  setConn("run", "running claude…");
  try {
    await t.invoke("start_session", { prompt: text, steer: steerNode ? steerNode.title : null });
  } catch (err) {
    setConn("err", String(err));
  }
}

async function replaySample() {
  const events = await loadSample();
  if (!events.length) return;
  model.reset(); rawEvents = []; canvas.sync();
  $("sesstitle").textContent = "Sample · auth refactor";
  autoFit = true;
  setConn("run", "replaying sample…");
  let i = 0;
  const step = () => {
    if (i >= events.length) { setConn("", "sample · done"); return; }
    const e = events[i++];
    ingest(e);
    const gap = e.type === "result" ? 0 : e.type === "user" ? 260 : 460;
    setTimeout(step, gap);
  };
  step();
}

let _sampleCache = null;
async function loadSample() {
  if (_sampleCache) return _sampleCache;
  try {
    const r = await fetch("/samples/sample-session.jsonl");
    const text = await r.text();
    _sampleCache = text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
  } catch (err) {
    console.error("sample load failed", err);
    _sampleCache = [];
  }
  return _sampleCache;
}

function setSource(s) {
  source = s;
  document.querySelectorAll(".srcsel button").forEach((b) => b.classList.toggle("active", b.dataset.src === s));
}

// ---- worktree sidebar (derived from agent nodes) ------------------------

function renderWts() {
  const wts = new Map();
  wts.set("main", { name: "main", color: "var(--wt-main)", git: "base" });
  for (const n of model.nodes) {
    if (n.type === "agent" && n._wt) {
      wts.set(n._wt.key, { name: n._wt.name, color: n._wt.color, git: n.status === "run" ? "running" : "ready" });
    }
  }
  const h = $("wtlist");
  h.innerHTML = "";
  if (wts.size <= 1 && !model.nodes.length) { h.innerHTML = `<div class="empty-side">No active worktrees yet.</div>`; return; }
  for (const [key, w] of wts) {
    const d = document.createElement("div");
    d.className = "wtrow" + (canvas.selWt === key ? " sel" : "");
    d.innerHTML = `<span class="sw" style="background:${w.color}"></span><div><div class="nm">${w.name}</div><div class="git">${w.git}</div></div>`;
    d.onclick = () => { canvas.setWtFilter(key); renderWts(); };
    h.appendChild(d);
  }
}

// ---- session list (single session for now) ------------------------------

function renderSessions() {
  $("sesslist").innerHTML =
    `<div class="sessrow active"><span class="aw-ic">${I.branch}</span><span class="t" id="sessname">current</span><span class="dot" style="background:var(--color-text-info)"></span></div>`;
}

// ---- connection pill ----------------------------------------------------

function setConn(cls, label) {
  const el = $("conn");
  el.className = "conn" + (cls ? " " + cls : "");
  el.textContent = label;
}
function clip(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; }

// ---- toolbar / prompt events --------------------------------------------

document.querySelectorAll(".srcsel button").forEach((b) =>
  b.onclick = () => { if (!b.disabled) setSource(b.dataset.src); });
$("send").onclick = () => fireSend();
$("prompt").addEventListener("keydown", (e) => { if (e.key === "Enter") fireSend(); });
function fireSend() {
  const i = $("prompt"), v = i.value.trim();
  if (!v && source !== "sample") return;
  i.value = "";
  sendPrompt(v);
}
$("newsession").onclick = () => { model.reset(); rawEvents = []; canvas.sync(); renderWts(); $("sesstitle").textContent = "No session"; setConn(tauri ? "live" : "", tauri ? "bridge ready" : "browser (sample only)"); };
$("zin").onclick = () => { autoFit = false; canvas.zoom(1.15); };
$("zout").onclick = () => { autoFit = false; canvas.zoom(1 / 1.15); };
$("fit").onclick = () => canvas.fit();
$("replay").onclick = () => {
  if (rawEvents.length) { const evs = rawEvents.slice(); model.reset(); rawEvents = []; canvas.sync(); let i = 0; const step = () => { if (i >= evs.length) return; ingest(evs[i++]); setTimeout(step, 360); }; step(); }
  else replaySample();
};
$("viewport").addEventListener("mousedown", () => { autoFit = false; });

// ---- boot ---------------------------------------------------------------

renderSessions();
renderWts();
wireBridge();
