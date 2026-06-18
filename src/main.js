// main.js — app wiring for "Claude Code with visual nodes".
//
// Multiple CHATS in the sidebar; each chat is one continuous Claude Code
// conversation rendered as a growing graph. Prompting APPENDS a turn (never
// resets) and resumes the chat's Claude session so context carries over.
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";
import { I } from "./icons.js";
import { GraphModel, layout } from "./graph.js";
import { CodeGraphModel } from "./codegraph.js";
import { Canvas } from "./canvas.js";

const $ = (id) => document.getElementById(id);

$("ic-plus").innerHTML = I.plus;
$("ic-up").innerHTML = I.up;
$("ic-play").innerHTML = I.play;
$("ic-empty").innerHTML = I.graph;
$("ic-newlane").innerHTML = I.plus;
$("ic-mic").innerHTML = I.mic;

const canvas = new Canvas(
  {
    world: $("world"), edges: $("edges"), viewport: $("viewport"),
    inspector: $("inspector"), inwrap: $("inwrap"), headpill: $("headpill"),
    target: null, empty: $("empty"), zl: $("zl"),
  },
  {
    onSteer: (_node, text) => sendPrompt(text),  // "follow up" from the inspector
    onNewLane: () => newLane(),                  // right-click "new agent lane"
    onPersist: () => scheduleSave(),             // notes moved/edited -> save
    onCompact: (laneId) => toggleCompact(laneId),// lane header "compact" button
    onUserCam: () => { autoFit = false; },       // user grabbed the camera -> stop following
    onLaneSelect: (laneId) => selectLane(laneId),// clicked a lane header -> make it active
  }
);

// ---- session (chat) state ----------------------------------------------

let sessions = [];        // [{ id, title, graph, cwd, edits, notes, activeLane, laneClaudeId }]
let cur = -1;             // index of the active chat
let runningId = null;     // bridge session key (chatId::lane) currently streaming
let runningChat = null;   // chat id of the streaming turn
let runningLane = "main"; // lane id of the streaming turn
const codeModel = new CodeGraphModel();
let view = "agents";      // 'agents' | 'code'
let codeLoaded = false;
let source = "live";      // 'live' | 'sample'
let tauri = null;
let autoFit = true;       // follow the conversation until the user pans/zooms
let fitPending = false;   // do a full fit on the next sync (turn start / switch)
let homePending = false;  // anchor a brand-new conversation at the top (no bounce)
let syncQueued = false;
let lastErr = "";         // last stderr line — shown if a turn ends with no result

const newId = () => "chat-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
const curChat = () => (cur >= 0 ? sessions[cur] : null);
const chatById = (id) => sessions.find((s) => s.id === id);

function newSession() {
  const s = { id: newId(), title: "New chat", graph: new GraphModel(), cwd: "", edits: true, notes: [], activeLane: "main", laneClaudeId: {} };
  sessions.push(s);
  switchSession(sessions.length - 1);
  scheduleSave();
}

function switchSession(i) {
  if (i < 0 || i >= sessions.length) return;
  cur = i;
  view = "agents";
  setView("agents");
  canvas.setModel(sessions[i].graph);
  canvas.setNotes(sessions[i].notes);
  canvas.selWt = null;
  canvas.deselect();
  $("sesstitle").textContent = sessions[i].title;
  $("folder").value = sessions[i].cwd || "";
  $("allowedits").checked = sessions[i].edits !== false;
  autoFit = true;
  closeLaneMenu();
  refreshLaneBar();
  renderSessions();
  canvas.sync();
  canvas.fit();
  scheduleSave();
}

// start a new independent agent lane in the current chat — spawns a "waiting
// for input" header node (a separate column on the board) that the next prompt
// flows into. The lane can be dragged around by its header.
function newLane() {
  const s = curChat(); if (!s) { newSession(); return; }
  const laneId = "lane" + (s.graph.laneOrder.length + 1) + "-" + Math.random().toString(36).slice(2, 5);
  s.graph.beginLane(laneId, { model: s.graph.meta.model || "claude", mode: s.edits ? "bypass" : "ask" });
  s.activeLane = laneId;
  if (view !== "agents") setView("agents");
  if (canvas.model !== s.graph) canvas.setModel(s.graph);
  autoFit = false;                 // keep the user's view; just reveal the lane
  canvas.sync();
  canvas.fit();
  refreshLaneBar();
  setConn(tauri ? "live" : "", "new agent lane — type a prompt to start it");
  $("prompt").focus();
  scheduleSave();
}

// switch which lane the prompt bar targets (drop-up / clicking a lane header)
function selectLane(laneId) {
  const s = curChat(); if (!s) return;
  s.activeLane = laneId;
  closeLaneMenu();
  refreshLaneBar();
  $("prompt").focus();
  scheduleSave();
}

// toggle a lane's compact view (collapse its tool/say nodes to dense lines)
function toggleCompact(laneId) {
  const s = curChat(); if (!s) return;
  const g = s.graph;
  g.laneCompact = g.laneCompact || {};
  g.laneCompact[laneId] = !g.laneCompact[laneId];
  canvas.sync();   // re-measure heights so the layout reflows around the change
  scheduleSave();
}

// ---- Tauri bridge --------------------------------------------------------

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
  await t.listen("claude-event", (e) => handleEvent(e.payload));
  await t.listen("claude-end", (e) => endTurn(e.payload && e.payload.ok !== false));
  await t.listen("claude-stderr", (e) => { const l = String(e.payload || "").trim(); if (l) lastErr = l; console.warn("[stderr]", l); });
}
function disableLive() {
  const btn = document.querySelector('.srcsel#srcsel button[data-src="live"]') || document.querySelector('#srcsel button[data-src="live"]');
  if (btn) { btn.disabled = true; btn.title = "Live runs in the desktop app (npm run app)"; btn.style.opacity = .45; }
}

// ---- the running turn ----------------------------------------------------

function handleEvent(evt) {
  if (!evt) return;
  const s = (runningChat && chatById(runningChat)) || curChat();
  if (!s) return;
  if (evt.type === "system" && evt.session_id) s.laneClaudeId[runningLane] = evt.session_id; // per-lane --resume
  s.graph.apply(evt);
  bump(s.graph);
}

function endTurn(ok) {
  const s = (runningChat && chatById(runningChat)) || curChat();
  if (s) {
    s.graph.endTurn(ok, ok ? "" : lastErr);
    // if a resumed turn failed, drop the stale session id so the next prompt
    // starts a fresh Claude session instead of failing again
    if (!ok && /resume|conversation|no session|session id/i.test(lastErr)) s.laneClaudeId[runningLane] = null;
    bump(s.graph);
  }
  runningId = null; runningChat = null;
  $("stopbtn").style.display = "none";
  setConn(tauri ? "live" : "", tauri ? "ready" : "browser (sample only)");
  refreshLaneBar();
  scheduleSave();
}

function bump(graph) {
  if (canvas.model === graph) scheduleSync();   // canvas measures heights + lays out + renders
  else { layout(graph); renderSessions(); }     // off-screen chat: rough pre-layout + sidebar dot
}

function scheduleSync() {
  if (syncQueued) return;
  syncQueued = true;
  const run = () => {
    if (!syncQueued) return;
    syncQueued = false;
    canvas.sync(); // canvas.sync() measures card heights + lays out the agent graph itself
    renderSessions();
    if (autoFit) {
      if (homePending) { homePending = false; canvas.home(); }      // first turn: anchor at top
      else if (fitPending) { fitPending = false; canvas.fit(); }
      else canvas.follow();   // pan to the newest node at constant zoom (no jumpy refit)
    }
  };
  requestAnimationFrame(run);
  setTimeout(run, 120);
}

// ---- prompting (append a turn) -------------------------------------------

async function sendPrompt(text) {
  if (source === "sample") { replaySampleTurn(); return; }
  text = (text || "").trim();
  if (!text) return;
  if (runningId) { setConn("run", "still working — wait for this turn"); return; } // one turn at a time
  if (!curChat()) newSession();
  const s = curChat();
  const lane = s.activeLane || "main";

  s.graph.meta.mode = s.edits ? "bypass" : "ask"; // lane header reflects the permission mode
  const firstEver = s.graph.turnCount === 0;
  s.graph.beginTurn(text, lane);
  if (s.title === "New chat") { s.title = clip(text, 40); }
  $("sesstitle").textContent = s.title;
  if (view !== "agents") setView("agents");
  if (canvas.model !== s.graph) canvas.setModel(s.graph);
  autoFit = true;
  homePending = firstEver;                 // anchor the very first conversation at the top
  fitPending = false;
  scheduleSync();
  refreshLaneBar();
  scheduleSave();

  const t = await getTauri();
  if (!t) { setConn("err", "no bridge — switch to sample"); s.graph.endTurn(false); scheduleSync(); return; }
  const key = s.id + "::" + lane;
  runningId = key; runningChat = s.id; runningLane = lane;
  lastErr = "";
  $("stopbtn").style.display = "";
  setConn("run", "working…");
  try {
    await t.invoke("start_session", { sessionId: key, prompt: text, resume: s.laneClaudeId[lane] || null, cwd: s.cwd || null, edits: !!s.edits });
  } catch (err) {
    setConn("err", String(err));
    s.graph.endTurn(false, "Couldn't start the turn — " + String(err));
    runningId = null; runningChat = null; $("stopbtn").style.display = "none"; bump(s.graph);
  }
}

async function stopTurn() {
  const t = await getTauri();
  if (t && runningId) { try { await t.invoke("stop_session", { sessionId: runningId }); } catch {} }
}

// ---- sample replay (each replay appends a turn) --------------------------

let _sample = null;
async function loadSample() {
  if (_sample) return _sample;
  try {
    const txt = await (await fetch("/samples/sample-session.jsonl")).text();
    _sample = txt.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
  } catch { _sample = []; }
  return _sample;
}
async function replaySampleTurn() {
  const events = await loadSample();
  if (!events.length) return;
  if (!curChat()) newSession();
  const s = curChat();
  if (canvas.model !== s.graph) canvas.setModel(s.graph);
  if (view !== "agents") setView("agents");
  s.graph.beginTurn("Refactor auth and add tests across the 3 packages");
  if (s.title === "New chat") { s.title = "Auth refactor"; $("sesstitle").textContent = s.title; }
  autoFit = true; homePending = s.graph.turnCount === 1; fitPending = false;
  refreshLaneBar();
  setConn("", "replaying…");
  let i = 0;
  const step = () => {
    if (i >= events.length) { s.graph.endTurn(true); bump(s.graph); refreshLaneBar(); setConn("", "sample"); return; }
    s.graph.apply(events[i++]);
    bump(s.graph);
    const e = events[i - 1];
    setTimeout(step, e.type === "result" ? 60 : e.type === "user" ? 220 : 380);
  };
  step();
}

// ---- Code Graph view -----------------------------------------------------

function setView(v) {
  view = v;
  document.querySelectorAll("#viewsel button").forEach((b) => b.classList.toggle("active", b.dataset.view === v));
}
async function switchView(v) {
  const requested = v;
  setView(v);
  if (v === "code") {
    await loadCodeGraph();
    if (view !== requested) return;
    codeModel.setTouched(touchedFiles());
    canvas.setModel(codeModel);
  } else {
    canvas.setModel(curChat() ? curChat().graph : new GraphModel());
  }
  canvas.selWt = null;
  canvas.deselect();
  canvas.sync();
  canvas.fit();
}
async function loadCodeGraph() {
  if (codeLoaded) return;
  let graph = null;
  const t = await getTauri();
  if (t) {
    setConn("run", "scanning repo…");
    try { graph = await t.invoke("scan_code_graph", { cwd: codeScanDir() }); setConn("live", "scanned repo"); }
    catch (err) { setConn("err", String(err)); }
  }
  if (!graph) graph = await loadJSON("/samples/sample-codegraph.json");
  codeModel.load(graph || { nodes: [], edges: [] });
  codeLoaded = true;
}
function codeScanDir() {
  // scan the chat's working folder if set, else where the session ran
  const s = curChat();
  return (s && s.cwd) || (s && s.graph.meta && s.graph.meta.cwd) || ".";
}
function touchedFiles() {
  const s = curChat();
  const out = new Set();
  if (!s) return out;
  for (const n of s.graph.nodes) {
    if (n.type !== "tool" || !(n.kind === "read" || n.kind === "edit" || n.kind === "write")) continue;
    const full = n.detail && n.detail.input && (n.detail.input.file_path || n.detail.input.notebook_path);
    const p = full || n.file;
    if (p) out.add(p);
  }
  return out;
}
async function loadJSON(url) {
  try { return await (await fetch(url)).json(); } catch { return null; }
}

function setSource(s) {
  source = s;
  document.querySelectorAll("#srcsel button").forEach((b) => b.classList.toggle("active", b.dataset.src === s));
}

// ---- sidebar (chats) -----------------------------------------------------

function renderSessions() {
  const h = $("sesslist");
  h.innerHTML = "";
  if (!sessions.length) { h.innerHTML = `<div class="empty-side">No chats yet — type below to start.</div>`; return; }
  sessions.forEach((s, i) => {
    const running = s.id === runningChat;
    const dot = running ? "var(--color-text-info)" : s.graph.turnCount ? "var(--color-text-success)" : "var(--color-border-secondary)";
    const d = document.createElement("div");
    d.className = "sessrow" + (i === cur ? " active" : "");
    d.innerHTML = `<span class="aw-ic">${I.branch}</span><span class="t">${escapeHtml(s.title)}</span><span class="dot" style="background:${dot}"></span>`;
    d.onclick = () => switchSession(i);
    h.appendChild(d);
  });
}
const escapeHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

function setConn(cls, label) {
  const el = $("conn");
  el.className = "conn" + (cls ? " " + cls : "");
  el.textContent = label;
}

// ---- prompt-bar lane controls (drop-up selector + mode/model/mic) --------

const laneWrap = () => document.querySelector(".lanewrap");
function laneLabel(s, laneId) {
  if (laneId === "main") return "main";
  const wt = s.graph.wtMap && s.graph.wtMap[laneId];
  return (wt && wt.name) || laneId;
}
function laneColor(s, laneId) {
  const wt = s.graph.wtMap && s.graph.wtMap[laneId];
  return (wt && wt.color) || "var(--wt-main)";
}
function shortModel(m) {
  if (!m) return "claude";
  const s = String(m).toLowerCase();
  if (s.includes("opus")) return "opus";
  if (s.includes("sonnet")) return "sonnet";
  if (s.includes("haiku")) return "haiku";
  return clip(m, 12);
}
function refreshLaneBar() {
  const s = curChat();
  if (!s) { $("lanename").textContent = "main"; $("laneSw").style.background = "var(--wt-main)"; return; }
  const lane = s.activeLane || "main";
  $("lanename").textContent = laneLabel(s, lane);
  $("laneSw").style.background = laneColor(s, lane);
  const bypass = s.edits !== false;
  const mode = $("pbmode");
  mode.textContent = bypass ? "bypass" : "ask";
  mode.classList.toggle("bypass", bypass);
  mode.title = bypass ? "bypass permissions — edits run without asking (click to require asking)" : "ask permissions (click to bypass)";
  $("pbmodel").textContent = shortModel(s.graph.meta.model);
  if (laneWrap() && laneWrap().classList.contains("open")) buildLaneMenu();
}
function buildLaneMenu() {
  const s = curChat(); const wrap = $("lanemenu"); if (!s || !wrap) return;
  const lanes = []; const seen = new Set();
  for (const id of ["main", ...s.graph.laneOrder, s.activeLane]) {
    if (!id || seen.has(id)) continue; seen.add(id); lanes.push(id);
  }
  let h = `<div class="mhead">Lanes</div>`;
  for (const id of lanes) {
    const lane = s.graph.lanes[id];
    const turns = lane ? lane.turns : 0;
    const sub = id === s.activeLane ? "active" : (turns ? turns + " turn" + (turns === 1 ? "" : "s") : "empty");
    h += `<div class="lanemenuitem${id === s.activeLane ? " active" : ""}" data-lane="${id}">
      <span class="sw" style="background:${laneColor(s, id)}"></span>
      <span class="nm">${escapeHtml(laneLabel(s, id))}</span><span class="sub">${sub}</span></div>`;
  }
  h += `<div class="lanemenuitem add" data-new="1"><span class="aw-ic">${I.plus}</span>New agent lane</div>`;
  wrap.innerHTML = h;
  wrap.querySelectorAll(".lanemenuitem[data-lane]").forEach((it) =>
    it.onclick = (e) => { e.stopPropagation(); selectLane(it.dataset.lane); });
  const add = wrap.querySelector(".lanemenuitem[data-new]");
  if (add) add.onclick = (e) => { e.stopPropagation(); closeLaneMenu(); newLane(); };
}
function toggleLaneMenu() {
  const w = laneWrap(); if (!w) return;
  w.classList.toggle("open");
  if (w.classList.contains("open")) buildLaneMenu();
}
function closeLaneMenu() { const w = laneWrap(); if (w) w.classList.remove("open"); }

// voice dictation via the WebView's Web Speech API (graceful no-op if absent)
let recog = null, recording = false;
function toggleMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { setConn("", "voice input isn't available in this build"); return; }
  if (recording) { try { recog && recog.stop(); } catch {} return; }
  try {
    recog = new SR(); recog.lang = "en-US"; recog.interimResults = true; recog.continuous = false;
    const base = $("prompt").value.trim();
    recog.onresult = (e) => {
      let t = ""; for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
      $("prompt").value = (base ? base + " " : "") + t.trim();
    };
    recog.onend = () => { recording = false; $("pbmic").classList.remove("on"); setConn(tauri ? "live" : "", tauri ? "ready" : "browser (sample only)"); };
    recog.onerror = () => { recording = false; $("pbmic").classList.remove("on"); setConn("", "voice input error"); };
    recog.start(); recording = true; $("pbmic").classList.add("on"); setConn("run", "listening…");
  } catch { setConn("", "voice input isn't available in this build"); }
}

// ---- local persistence (saved like Claude Code sessions) ----------------

const STORE = "droolcat.sessions.v1";
let saveTimer = null;
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveSessions, 500); }
function saveSessions() {
  try {
    const data = {
      cur,
      sessions: sessions.map((s) => ({
        id: s.id, title: s.title, cwd: s.cwd, edits: s.edits, activeLane: s.activeLane,
        laneClaudeId: s.laneClaudeId, notes: s.notes, graph: s.graph.toJSON(),
      })),
    };
    localStorage.setItem(STORE, JSON.stringify(data));
  } catch (e) { console.warn("save failed", e); }
}
function loadSessions() {
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) return false;
    const d = JSON.parse(raw);
    if (!d || !Array.isArray(d.sessions) || !d.sessions.length) return false;
    sessions = d.sessions.map((s) => ({
      id: s.id, title: s.title || "chat", cwd: s.cwd || "", edits: s.edits !== false,
      activeLane: s.activeLane || "main", laneClaudeId: s.laneClaudeId || {},
      notes: Array.isArray(s.notes) ? s.notes : [], graph: new GraphModel().fromJSON(s.graph),
    }));
    cur = Math.min(Math.max(0, d.cur || 0), sessions.length - 1);
    return true;
  } catch (e) { console.warn("load failed", e); return false; }
}
function clip(s, n) { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; }

// ---- toolbar / prompt events --------------------------------------------

document.querySelectorAll("#srcsel button").forEach((b) =>
  b.onclick = () => { if (!b.disabled) setSource(b.dataset.src); });
document.querySelectorAll("#viewsel button").forEach((b) =>
  b.onclick = () => switchView(b.dataset.view));
$("send").onclick = () => fireSend();
$("prompt").addEventListener("keydown", (e) => { if (e.key === "Enter") fireSend(); });
function fireSend() {
  const i = $("prompt"), v = i.value.trim();
  if (!v && source !== "sample") return;
  i.value = "";
  sendPrompt(v);
}
$("newsession").onclick = () => newSession();
$("folder").addEventListener("change", () => { const s = curChat(); if (s) { s.cwd = $("folder").value.trim(); scheduleSave(); } });
$("allowedits").addEventListener("change", () => { const s = curChat(); if (s) { s.edits = $("allowedits").checked; refreshLaneBar(); scheduleSave(); } });
$("lanebtn").onclick = (e) => { e.stopPropagation(); toggleLaneMenu(); };
$("pbnew").onclick = () => newLane();
$("pbmic").onclick = () => toggleMic();
$("pbmode").onclick = () => { const s = curChat(); if (!s) return; s.edits = !s.edits; $("allowedits").checked = s.edits; refreshLaneBar(); scheduleSave(); };
document.addEventListener("click", (e) => { const w = laneWrap(); if (w && w.classList.contains("open") && !w.contains(e.target)) closeLaneMenu(); });
$("stopbtn").onclick = stopTurn;
$("zin").onclick = () => { autoFit = false; canvas.zoom(1.15); };
$("zout").onclick = () => { autoFit = false; canvas.zoom(1 / 1.15); };
$("fit").onclick = () => canvas.fit();
$("replay").onclick = () => { if (source === "sample") replaySampleTurn(); else replaySampleTurn(); };
$("viewport").addEventListener("mousedown", () => { autoFit = false; });

// ---- boot ---------------------------------------------------------------

if (loadSessions()) switchSession(cur >= 0 ? cur : 0);  // restore saved chats
else newSession();                                       // or start fresh
window.addEventListener("beforeunload", saveSessions);
wireBridge();
