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
import { VoiceMode } from "./voice.js";
import { mdChat } from "./md.js";

const $ = (id) => document.getElementById(id);

// ---- toasts + in-app modal (no native confirm; powers first-run consent) ----
function toast(msg, { kind = "", actionLabel, onAction, timeout = 4500 } = {}) {
  const host = $("toasts"); if (!host) return;
  const el = document.createElement("div");
  el.className = "toast" + (kind ? " " + kind : "");
  const span = document.createElement("span"); span.textContent = msg; el.appendChild(span);
  if (actionLabel) {
    const b = document.createElement("button"); b.textContent = actionLabel;
    b.onclick = () => { el.remove(); onAction && onAction(); };
    el.appendChild(b);
  }
  host.appendChild(el);
  if (timeout) setTimeout(() => el.remove(), timeout);
  return el;
}
function modalConfirm({ title, body, confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false } = {}) {
  return new Promise((resolve) => {
    $("modalTitle").textContent = title || "";
    $("modalBody").innerHTML = body || "";
    const acts = $("modalActions"); acts.innerHTML = "";
    const cancel = document.createElement("button"); cancel.textContent = cancelLabel;
    const ok = document.createElement("button"); ok.textContent = confirmLabel; ok.className = "primary" + (danger ? " danger" : "");
    const close = (v) => { $("modal").style.display = "none"; document.removeEventListener("keydown", onKey, true); resolve(v); };
    cancel.onclick = () => close(false);
    ok.onclick = () => close(true);
    acts.append(cancel, ok);
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); close(false); } else if (e.key === "Enter") { e.preventDefault(); close(true); } };
    document.addEventListener("keydown", onKey, true);
    $("modal").style.display = "flex";
    setTimeout(() => ok.focus(), 0);
  });
}
const CONSENT_KEY = "droolcat.bypassConsent.v1";
// grow the composer with its content (Claude Code-style), capped by CSS max-height.
// An empty textarea misreports scrollHeight in this flex row, so for empty we just
// clear the inline height and let the CSS 1-row default stand.
function autoGrowPrompt() {
  const t = $("prompt"); if (!t) return;
  if (!t.value) { t.style.height = ""; return; }
  t.style.height = "0px";
  t.style.height = Math.min(168, t.scrollHeight) + "px";
}

$("ic-plus").innerHTML = I.plus;
$("ic-up").innerHTML = I.up;
$("ic-play").innerHTML = I.play;
$("ic-empty").innerHTML = I.graph;
$("ic-newlane").innerHTML = I.plus;
$("ic-newlane2").innerHTML = I.plus;
$("ic-mic").innerHTML = I.mic;
$("ic-follow").innerHTML = I.follow;
$("ic-cpsend").innerHTML = I.up;
$("ic-companion").innerHTML = I.split;
$("ic-companionapp").innerHTML = I.split;
$("ic-companionbtn").innerHTML = I.split;

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
    onUserCam: () => { setFollow(false); },      // user grabbed the camera -> stop following
    onLaneSelect: (laneId) => selectLane(laneId),// clicked a lane header -> make it active
    onCloseAux: () => setView("agents"),         // closed the code cluster -> reflect in the tab
    onRemoveLane: (laneId) => removeLane(laneId), // × on a lane header / right-click -> remove it
  }
);

// hands-free Voice Mode — listen, send into the active lane, read the reply back
const voice = new VoiceMode(
  {
    root: $("voicemode"), canvas: $("vmRings"), core: $("vmCore"),
    status: $("vmStatus"), transcript: $("vmTranscript"), lane: $("vmLaneName"),
    pause: $("vmPause"), exit: $("vmExit"),
    fallback: $("vmFallback"), fallbackInput: $("vmFallbackInput"),
  },
  {
    onUtterance: (text) => {
      const s = curChat(); if (!s) return;
      voice.pendingChat = s.id; voice.pendingLane = s.activeLane;
      sendPrompt(text);
    },
    getLaneLabel: () => { const s = curChat(); return s ? laneLabel(s, s.activeLane) : "main"; },
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
// the "follow live" toolbar toggle mirrors autoFit: when on, the camera keeps
// the newest node in view as the graph grows; a manual pan/zoom turns it off
function updateFollowBtn() { const b = $("followbtn"); if (b) b.classList.toggle("on", autoFit); }
function setFollow(on) { autoFit = !!on; updateFollowBtn(); }
let syncQueued = false;
let lastErr = "";         // last stderr line — shown if a turn ends with no result
let runQueue = [];        // Board-Helper-spawned lane runs, executed one at a time
let queueReturnLane = null; // { chatId, lane } — lane to restore once the queue drains
let observeTimer = null;  // live-tail poll for the active observed Claude Code session
let observeGen = 0;       // bumped on every (re)start/stop so stale async polls bail
let lastCcList = [];      // last-rendered Claude Code session list
let logs = [];            // rolling activity log for the HUD panel
let hudOpen = false, hudTab = "logs";

// The Board Helper is a built-in organizer agent. It talks in its own lane and
// can act on the board by ending a reply with a ```board JSON action block.
const BOARD_HELPER_SYSTEM =
  "You are the Board Helper for Droolcat, a visual board where Claude Code conversations run as lanes of nodes. " +
  "You help the user ORGANIZE, NAVIGATE and DELEGATE work on the board, and answer questions about what is on it. " +
  "A snapshot of the current board is included at the top of each user message — use it to find things and to give board help. " +
  "Reply briefly and conversationally. To act on the board, END your reply with a single fenced code block tagged `board` " +
  "containing a JSON array of actions. Supported actions: " +
  '{"action":"spawnLane","title":"short label","prompt":"first prompt to run in a new lane"} — start a new agent lane and run a prompt in it; ' +
  '{"action":"note","text":"..."} — pin a sticky note; ' +
  '{"action":"compact","lane":"main"} — collapse a lane; ' +
  '{"action":"focus","query":"text to find and fly to"} (or {"action":"focus","lane":"main"}) — move the camera to a node/lane; ' +
  '{"action":"search","query":"text"} — highlight every matching node; ' +
  '{"action":"fit"} — fit the whole board in view; ' +
  '{"action":"arrange"} — tidy the lanes back to a clean auto-layout. ' +
  "Only include the board block when actions are warranted, and put nothing after it. Keep each spawned prompt self-contained.";

// a compact snapshot of the board, prepended to Board Helper prompts so it can
// answer questions and navigate to things without seeing the screen
function boardContext(s) {
  const g = s.graph;
  const lanes = g.laneOrder.filter((l) => l !== "board").map((l) => `${laneLabel(s, l)} (${g.lanes[l].turns} turn${g.lanes[l].turns === 1 ? "" : "s"})`);
  const recent = g.nodes.filter((n) => n.type !== "lane").slice(-24).map((n) => {
    if (n.type === "prompt") return `you: ${clip(n.text, 60)}`;
    if (n.type === "say") return `claude: ${clip(n.text, 60)}`;
    if (n.type === "tool") return `${n.title} ${n.file || ""}`.trim();
    if (n.type === "result") return `result: ${clip(n.summary, 60)}`;
    if (n.type === "agent") return `subagent: ${n.title}`;
    return n.type;
  });
  return `[Board snapshot — lanes: ${lanes.join(", ") || "main"}.\nRecent activity:\n- ${recent.join("\n- ") || "(empty)"}\n]\n\n`;
}

const newId = () => "chat-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
const curChat = () => (cur >= 0 ? sessions[cur] : null);
const chatById = (id) => sessions.find((s) => s.id === id);

function newSession() {
  const s = { id: newId(), title: "New chat", graph: new GraphModel(), cwd: "", edits: true, notes: [], activeLane: "main", laneClaudeId: {}, model: "" };
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
  closePlusMenu();
  refreshLaneBar();
  if (hudOpen) renderHud();
  if (panelOpen) renderPanel();
  renderSessions();
  canvas.sync();
  canvas.goLatest();   // land zoomed-in on the latest nodes when switching chats
  scheduleSave();
  pump();   // resume any Board-Helper-queued runs waiting on this chat
  stopObserving();
  if (sessions[i].observed) startObserving(sessions[i]);  // live-tail the real session
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

// remove an agent lane (× on its header / right-click). main can't be removed.
async function removeLane(laneId) {
  const s = curChat(); if (!s || laneId === "main") return;
  const g = s.graph;
  if (runningChat === s.id && runningLane === laneId) { toast("That lane is still working — stop it first."); return; }
  const lane = g.lanes[laneId];
  const turns = (lane && lane.turns) || 0;
  if (turns > 0) {
    const ok = await modalConfirm({ title: "Remove this lane?", body: `<b>${escapeHtml(laneLabel(s, laneId))}</b> has ${turns} turn${turns > 1 ? "s" : ""} of work. Removing it deletes those nodes from the board.`, confirmLabel: "Remove lane", danger: true });
    if (!ok) return;
  }
  const label = laneLabel(s, laneId);
  g.removeLane(laneId);
  if (s.activeLane === laneId) s.activeLane = "main";
  if (s.laneClaudeId) delete s.laneClaudeId[laneId];
  closeLaneMenu();
  scheduleSync();
  refreshLaneBar();
  scheduleSave();
  toast(`Removed ${clip(label, 30)}`);
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
  logEvent(s, evt);
  bump(s.graph);
  scheduleSave();   // persist the conversation as it streams (debounced), not just at turn end
}

const AUTH_RE = /\b401\b|invalid authentication|not (?:signed|logged) in|unauthor|credential|please run.{0,12}login|claude login|missing api key|oauth/i;
function turnErrorText(s, lane) {
  const L = s.graph.lanes[lane];
  const r = L ? s.graph.byId[L.lastResultId] : null;
  return ((lastErr || "") + " " + (r && r.summary ? r.summary : "")).trim();
}
function showAuthHelp() {
  setConn("err", "Claude Code not signed in");
  toast("Claude Code isn't signed in — that's why the turn failed.", { kind: "err", timeout: 9000, actionLabel: "How to fix", onAction: () => modalConfirm({
    title: "Claude Code isn't signed in",
    body: `The <code>claude</code> CLI that Droolcat drives returned <b>401 — invalid credentials</b>. Droolcat can't sign in for you.<br><br>Open a terminal and run:<br><br><code>claude login</code><br><br>(or set an <code>ANTHROPIC_API_KEY</code> in your environment). Then come back and send your prompt again.`,
    confirmLabel: "Got it", cancelLabel: "Close",
  }) });
}
function endTurn(ok) {
  const s = (runningChat && chatById(runningChat)) || curChat();
  const wasLane = runningLane;
  let authFail = false;
  if (s) {
    s.graph.endTurn(ok, ok ? "" : lastErr);
    if (!ok) authFail = AUTH_RE.test(turnErrorText(s, wasLane));
    // if a resumed turn failed, drop the stale session id so the next prompt
    // starts a fresh Claude session instead of failing again
    if (!ok && /resume|conversation|no session|session id/i.test(lastErr)) s.laneClaudeId[runningLane] = null;
    logs.push({ t: nowClock(), kind: ok ? "ok" : "err", text: ok ? `✓ ${laneLabel(s, wasLane)} done` : `✗ ${laneLabel(s, wasLane)} — ${clip(lastErr || "ended", 48)}` });
    bump(s.graph);
  }
  runningId = null; runningChat = null;
  $("stopbtn").style.display = "none";
  setConn(tauri ? "live" : "", tauri ? "ready" : "browser (sample only)");
  refreshLaneBar();
  if (authFail) showAuthHelp();
  if (hudOpen) renderHud();
  // Board Helper finished -> execute any board actions it proposed
  if (ok && s && wasLane === "board") {
    const lane = s.graph.lanes["board"];
    const res = lane && s.graph.byId[lane.lastResultId];
    if (res && res.summary) runBoardActions(parseBoardBlock(res.summary), s);
  }
  // Voice Mode -> read the reply of the turn it initiated back aloud
  if (voice.active && s && voice.pendingChat === s.id) {
    const L = s.graph.lanes[voice.pendingLane];
    const res = L && s.graph.byId[L.lastResultId];
    voice.speak(res && res.summary ? res.summary : (ok ? "Done." : "That turn ended without a response."));
    voice.pendingChat = null;
  }
  scheduleSave();
  pump();   // run the next queued lane, if any
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
    if (panelOpen && panelTab === "chat") renderConversation();
    if (autoFit) {
      if (homePending) { homePending = false; canvas.home(); }      // first turn: anchor at top
      else if (fitPending) { fitPending = false; canvas.fit(); }
      else canvas.follow();   // pan to the newest node at constant zoom (no jumpy refit)
    }
    updateFollowBtn();        // keep the follow toggle in sync with autoFit
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

  // first live turn with permissions bypassed -> one-time, plain-language consent
  if (tauri && s.edits !== false && !localStorage.getItem(CONSENT_KEY)) {
    const folder = (s.cwd && s.cwd.trim()) || "your home folder";
    const ok = await modalConfirm({
      title: "Claude will act without asking",
      body: `Droolcat runs Claude Code with <b>permissions bypassed</b> — it can read, edit, and run shell commands <b>without approving each step</b>, working in <code>${escapeHtml(folder)}</code>.<br><br>Point a chat at a specific project with the <b>+</b> button if you'd rather it not touch your home directory. You can switch to <b>ask</b> mode anytime with the red pill.`,
      confirmLabel: "I understand — continue", cancelLabel: "Cancel", danger: true,
    });
    if (!ok) { toast("Nothing sent — bypass wasn't approved."); $("prompt").value = text; autoGrowPrompt(); return; }
    try { localStorage.setItem(CONSENT_KEY, "1"); } catch {}
  }

  // continuing an observed session hands it off to Droolcat: stop tailing, close
  // the open observed turn cleanly (no fake "Done." node), and let this turn
  // resume the real Claude session (laneClaudeId.main is its id)
  if (s.observed) { stopObserving(); s.observed = null; s.graph.closeObservedTurn(); if (lastCcList.length) renderCcList(lastCcList); }

  s.graph.meta.mode = s.edits ? "bypass" : "ask"; // lane header reflects the permission mode
  s.graph.meta.pickedModel = s.model || "";       // header shows the model you picked
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
  logs.push({ t: nowClock(), kind: "sys", text: `▶ turn in ${laneLabel(s, lane)} — ${clip(text, 48)}` });
  // the Board Helper gets a fresh board snapshot prepended to its prompt (the
  // visible prompt node still shows just the user's words)
  const sendText = lane === "board" ? boardContext(s) + text : text;
  try {
    await t.invoke("start_session", {
      sessionId: key, prompt: sendText, resume: s.laneClaudeId[lane] || null,
      cwd: s.cwd || null, edits: !!s.edits, model: s.model || null,
      appendSystem: lane === "board" ? BOARD_HELPER_SYSTEM : null,
    });
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
  // the conversation stays the canvas model; the code graph lives ON the board
  // as a cluster to the right. The tab just focuses one region or the other.
  if (v === "code") {
    setConn("run", "scanning repo…");
    await loadCodeGraph();
    if (view !== requested) { setConn(tauri ? "live" : "", tauri ? "ready" : "browser (sample only)"); return; }
    codeModel.setTouched(touchedFiles());
    canvas.setAux(codeModel);     // render/refresh the code cluster on the board
    setConn(tauri ? "live" : "", tauri ? "ready" : "browser (sample only)");
    autoFit = false;
    canvas.focusAux();            // pan to the code region
  } else {
    autoFit = false;
    canvas.fit();                 // back to the conversation (code stays on board)
  }
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

const SIDE_MIN = 156, SIDE_MAX = 480, SIDE_KEY = "droolcat.sideW";
function setSideWidth(px, persist) {
  const w = Math.max(SIDE_MIN, Math.min(SIDE_MAX, Math.round(px)));
  document.documentElement.style.setProperty("--side-w", w + "px");
  if (persist) { try { localStorage.setItem(SIDE_KEY, String(w)); } catch {} }
  return w;
}
function wireSidebarResize() {
  const handle = $("sideresize"), side = document.querySelector(".side");
  if (!handle || !side) return;
  let saved = parseInt(localStorage.getItem(SIDE_KEY) || "", 10);
  if (saved >= SIDE_MIN && saved <= SIDE_MAX) setSideWidth(saved, false);
  let dragging = false;
  const move = (e) => {
    if (!dragging) return;
    if (!(e.buttons & 1)) { up(); return; }          // mouse released off-window
    setSideWidth(e.clientX - side.getBoundingClientRect().left, false);
  };
  const up = () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("drag");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    const w = parseInt(getComputedStyle(side).width, 10);
    if (w) setSideWidth(w, true);
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
  };
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    dragging = true;
    handle.classList.add("drag");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
  handle.addEventListener("dblclick", () => setSideWidth(178, true));   // reset to default
  window.addEventListener("blur", up);
}

function renderSessions() {
  const h = $("sesslist");
  h.innerHTML = "";
  if (!sessions.length) { h.innerHTML = `<div class="empty-side">No chats yet — type below to start.</div>`; return; }
  sessions.forEach((s, i) => {
    const running = s.id === runningChat;
    const dot = running ? "var(--color-text-info)" : s.graph.turnCount ? "var(--color-text-success)" : "var(--color-border-secondary)";
    const d = document.createElement("div");
    d.className = "sessrow" + (i === cur ? " active" : "");
    d.tabIndex = 0; d.setAttribute("role", "button"); d.title = "double-click to rename";
    d.innerHTML = `<span class="aw-ic">${I.branch}</span><span class="t">${escapeHtml(s.title)}</span>${s.observed ? '<span class="obspill">live</span>' : ""}<span class="dot" style="background:${dot}"></span><button class="sessdel" title="delete chat">×</button>`;
    d.onclick = () => switchSession(i);
    d.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); switchSession(i); } else if (e.key === "F2") { e.preventDefault(); startRename(i, d); } };
    d.ondblclick = (e) => { e.preventDefault(); if (!s.observed) startRename(i, d); };
    d.querySelector(".sessdel").onclick = (e) => { e.stopPropagation(); deleteSession(i); };
    h.appendChild(d);
  });
}
// inline-rename a chat: swap its title for an input, commit on Enter/blur
function startRename(i, row) {
  const s = sessions[i]; if (!s) return;
  const span = row.querySelector("span.t"); if (!span) return;
  const inp = document.createElement("input");
  inp.className = "sessrename"; inp.value = s.title;
  span.replaceWith(inp);
  inp.focus(); inp.select();
  const commit = () => {
    const v = inp.value.trim();
    if (v && v !== s.title) { s.title = clip(v, 80); s.titleEdited = true; scheduleSave(); if (i === cur) $("sesstitle").textContent = s.title; }
    renderSessions();
  };
  inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); commit(); } else if (e.key === "Escape") { e.preventDefault(); renderSessions(); } };
  inp.onblur = commit;
  inp.onclick = (e) => e.stopPropagation();
}
async function deleteSession(i) {
  const s = sessions[i]; if (!s) return;
  const ok = await modalConfirm({ title: "Delete chat?", body: `Delete <b>${escapeHtml(clip(s.title, 50))}</b>? You can undo this for a few seconds.`, confirmLabel: "Delete", danger: true });
  if (!ok) return;
  const removed = s, removedAt = i;
  doDeleteSession(i);
  toast(`Deleted "${clip(removed.title, 30)}"`, { actionLabel: "Undo", timeout: 7000, onAction: () => {
    sessions.splice(Math.min(removedAt, sessions.length), 0, removed);
    cur = sessions.indexOf(removed); switchSession(cur);
  } });
}
function doDeleteSession(i) {
  const s = sessions[i]; if (!s) return;
  const wasCur = i === cur;
  if (wasCur && s.observed) stopObserving();
  if (runningChat === s.id) { runningChat = null; runningId = null; }
  sessions.splice(i, 1);
  if (!sessions.length) { cur = -1; newSession(); return; }
  if (wasCur) { cur = Math.min(i, sessions.length - 1); switchSession(cur); }
  else { if (i < cur) cur--; renderSessions(); }
  scheduleSave();
}
const escapeHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

// ---- observe real Claude Code sessions (~/.claude/projects) ---------------

async function loadCcSessions() {
  const t = await getTauri();
  if (!t) return;   // browser build keeps the "desktop app only" hint
  try {
    const list = await t.invoke("list_claude_sessions", { limit: 40 });
    renderCcList(list || []);
  } catch (e) { $("cclist").innerHTML = `<div class="empty-side">Couldn't read sessions.</div>`; }
}
function renderCcList(list) {
  lastCcList = list || lastCcList;
  const host = $("cclist");
  host.innerHTML = "";
  // hide throwaway greeting sessions ("hi", "hey", …) from the list. A real
  // session gets a descriptive aiTitle, so a bare-greeting title means a
  // throwaway. Files on disk are left untouched.
  const shown = lastCcList.filter((info) => !GREETING.test(info.title || ""));
  if (!shown.length) { host.innerHTML = `<div class="empty-side">No Claude Code sessions${lastCcList.length ? " (greeting-only hidden)" : " found"}.</div>`; return; }
  const activeRealId = curChat() && curChat().observed && curChat().observed.realId;
  for (const info of shown) {
    const isLive = info.id === activeRealId;
    const d = document.createElement("div");
    d.className = "ccrow" + (isLive ? " live active" : "");
    d.innerHTML = `<span class="ccdot"></span><div class="ccmeta"><div class="cct">${escapeHtml(info.title || "session")}</div>
      <div class="ccsub">${escapeHtml(projectBase(info.cwd || info.project))} · ${relTime(info.mtimeMs)}</div></div>`;
    d.onclick = () => observeSession(info);
    host.appendChild(d);
  }
}
function projectBase(p) {
  const parts = String(p || "").replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.slice(-1)[0] || "session";
}
function relTime(ms) {
  if (!ms) return "";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}
function parseJsonl(lines) {
  const out = [];
  for (const l of (lines || [])) { try { out.push(JSON.parse(l)); } catch {} }
  return out;
}
// keep only the last `n` real user-prompt turns from a parsed transcript
function trimToLastTurns(objs, n) {
  const idxs = [];
  for (let i = 0; i < objs.length; i++) {
    const o = objs[i];
    if (o && o.type === "user" && o.message && !o.isSidechain) {
      const c = o.message.content;
      if (!(Array.isArray(c) && c.some((b) => b && b.type === "tool_result"))) idxs.push(i);
    }
  }
  return idxs.length <= n ? objs : objs.slice(idxs[idxs.length - n]);
}

// open (or reuse) a chat that mirrors a real Claude Code session and live-tails it
async function observeSession(info) {
  const t = await getTauri(); if (!t) return;
  let s = sessions.find((x) => x.observed && x.observed.realId === info.id);
  if (!s) {
    s = {
      id: newId(), title: info.title || "Claude Code", graph: new GraphModel(), cwd: info.cwd || "",
      edits: false, notes: [], activeLane: "main", laneClaudeId: { main: info.id },
      observed: { file: info.file, realId: info.id, offset: 0 },
    };
    sessions.push(s);
  }
  switchSession(sessions.indexOf(s));   // switchSession arms observation for observed chats
}

// ---- companion split-screen mode -----------------------------------------
// Snap Droolcat right, launch a real `claude` terminal left (in the chosen
// folder), then auto-detect and live-mirror that session here.
const normPath = (p) => String(p || "").replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
let companionWatch = 0;
async function startCompanion() {
  const t = await getTauri();
  closePlusMenu();
  if (!t) { toast("Companion mode needs the desktop app (it launches a real terminal)."); return; }
  const folder = ($("folder").value || (curChat() && curChat().cwd) || "").trim();
  setConn("run", "arranging the split screen…");
  try {
    const info = await t.invoke("companion_layout", { cwd: folder });
    toast(info.positionedTerminal
      ? "Companion launched — a real claude terminal is on the left."
      : "Companion launched — press Win+← to snap the terminal to the left half.",
      { kind: "ok", timeout: 8000 });
    watchForCompanionSession(folder, info.launchedAt || Date.now());
  } catch (e) { setConn("err", "couldn't launch companion"); toast(String(e), { kind: "err", timeout: 8000 }); }
}
// side-by-side with the REAL Claude desktop app: snap it left, Droolcat right,
// then mirror whichever session is active (the app writes the same files).
async function startCompanionApp() {
  const t = await getTauri();
  closePlusMenu();
  if (!t) { toast("Companion mode needs the desktop app."); return; }
  setConn("run", "arranging Claude app + Droolcat…");
  try {
    const info = await t.invoke("arrange_with_claude_app");
    if (!info.ok) { setConn(tauri ? "live" : "", "ready"); toast("Couldn't find the Claude app — open it, then try again.", { kind: "err", timeout: 8000 }); return; }
    toast(info.positionedTerminal
      ? "Side-by-side — Claude app on the left, Droolcat on the right. Work in Claude; it mirrors here."
      : "Droolcat snapped right — press Win+← to put the Claude app on the left.",
      { kind: "ok", timeout: 8000 });
    mirrorActiveSession(info.launchedAt || Date.now());
  } catch (e) { setConn("err", "couldn't arrange"); toast(String(e), { kind: "err", timeout: 8000 }); }
}
// grab the session you're actively using in Claude (newest, recent) and mirror it
function mirrorActiveSession(since) {
  const gen = ++companionWatch;
  setConn("run", "finding your Claude session…");
  let tries = 0;
  const tick = async () => {
    if (gen !== companionWatch) return;
    const t = await getTauri(); if (!t) return;
    tries++;
    try {
      const list = await t.invoke("list_claude_sessions", { limit: 50 });
      const recent = (list || []).filter((x) => (x.mtimeMs || 0) > since - 900000).sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
      const active = recent.find((x) => (x.mtimeMs || 0) >= since - 4000) || recent[0];   // prefer just-touched, else most recent
      if (active) { setConn("live", "mirroring your Claude session"); observeSession(active); return; }
    } catch {}
    if (gen !== companionWatch) return;
    if (tries < 60) setTimeout(tick, 1500);
    else setConn(tauri ? "live" : "", "no recent session — start a chat in Claude");
  };
  setTimeout(tick, 800);
}
// poll for the session the left-side terminal creates, then mirror it
function watchForCompanionSession(folder, since) {
  const gen = ++companionWatch;
  const want = normPath(folder);
  setConn("run", "waiting for the claude session…");
  let tries = 0;
  const tick = async () => {
    if (gen !== companionWatch) return;
    const t = await getTauri(); if (!t) return;
    tries++;
    try {
      const list = await t.invoke("list_claude_sessions", { limit: 50 });
      const match = (list || [])
        .filter((x) => (!want || normPath(x.cwd) === want) && (x.mtimeMs || 0) >= since - 4000)
        .sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0))[0];
      if (match) { setConn("live", "mirroring the live session"); toast("Found the session — mirroring it live.", { kind: "ok" }); observeSession(match); return; }
    } catch {}
    if (gen !== companionWatch) return;
    if (tries < 60) setTimeout(tick, 1500);
    else setConn(tauri ? "live" : "", "no session yet — type a prompt in the terminal");
  };
  setTimeout(tick, 1200);
}

async function startObserving(s) {
  stopObserving();
  const gen = observeGen;
  const t = await getTauri();
  if (!t || !s || !s.observed || gen !== observeGen) return;
  // switching back to an already-loaded observed chat: keep its accumulated
  // scrollback + view and just resume tailing (don't reset/refit)
  if (s.observed.offset && s.graph.turnCount > 0) {
    observeTimer = setInterval(() => pollObserve(s, gen), 1500);
    return;
  }
  try {
    const tail = await t.invoke("read_session_tail", { path: s.observed.file, maxLines: 160, maxBytes: 700000 });
    if (gen !== observeGen || curChat() !== s || !s.observed) return; // superseded / switched away
    s.graph.reset();
    s.graph.ingestTranscript(trimToLastTurns(parseJsonl(tail.lines), 4));
    s.observed.offset = tail.offset;
    if (canvas.model === s.graph) { canvas.sync(); autoFit = true; canvas.goLatest(); }   // land zoomed-in on the latest, then follow
    renderSessions();
    if (lastCcList.length) renderCcList(lastCcList);
  } catch (e) { console.warn("observe tail failed", e); setConn("err", "couldn't read that session"); }
  if (gen !== observeGen) return;   // don't arm a superseded timer
  observeTimer = setInterval(() => pollObserve(s, gen), 1500);
}
function stopObserving() { observeGen++; if (observeTimer) { clearInterval(observeTimer); observeTimer = null; } }

async function pollObserve(s, gen) {
  if (gen !== observeGen || !s || !s.observed || curChat() !== s || runningId) return; // pause while a turn streams
  const t = await getTauri(); if (!t) return;
  try {
    const r = await t.invoke("read_session_since", { path: s.observed.file, offset: s.observed.offset });
    // re-validate after the await — the user may have switched chats or handed off
    if (gen !== observeGen || curChat() !== s || !s.observed || runningId) return;
    s.observed.offset = r.offset;
    if (r.lines && r.lines.length) {
      s.graph.ingestTranscript(parseJsonl(r.lines));
      if (canvas.model === s.graph) scheduleSync();
      scheduleSave();
    }
  } catch (e) { /* file rotated/removed — let the next poll retry */ }
}

function setConn(cls, label) {
  const el = $("conn");
  el.className = "conn" + (cls ? " " + cls : "");
  el.textContent = label;
}

// ---- prompt-bar lane controls (drop-up selector + mode/model/mic) --------

const laneWrap = () => document.getElementById("lanewrap");
const plusWrap = () => document.getElementById("pluswrap");
function laneLabel(s, laneId) {
  if (laneId === "main") return "main";
  if (laneId === "board") return "Board Helper";
  const wt = s.graph.wtMap && s.graph.wtMap[laneId];
  return (wt && wt.name) || laneId;
}
function laneColor(s, laneId) {
  if (laneId === "board") return "#b5791b";
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
  $("pbmodel").textContent = modelLabel(s);
  if (laneWrap() && laneWrap().classList.contains("open")) buildLaneMenu();
}

const MODELS = [
  { id: "", label: "default" },
  { id: "opus", label: "opus" },
  { id: "sonnet", label: "sonnet" },
  { id: "haiku", label: "haiku" },
];
function modelLabel(s) { return (s && s.model) ? s.model : shortModel(s && s.graph.meta.model); }
const modelWrap = () => document.getElementById("modelwrap");
function buildModelMenu() {
  const s = curChat(); const wrap = $("modelmenu"); if (!wrap) return;
  wrap.innerHTML = `<div class="mhead">Model</div>` + MODELS.map((m) =>
    `<div class="lanemenuitem${s && (s.model || "") === m.id ? " active" : ""}" data-model="${m.id}"><span class="nm">${m.label}</span>${m.id === "" ? '<span class="sub">CLI default</span>' : ""}</div>`).join("");
  wrap.querySelectorAll(".lanemenuitem[data-model]").forEach((it) =>
    it.onclick = (e) => { e.stopPropagation(); selectModel(it.dataset.model); });
}
function toggleModelMenu() { const w = modelWrap(); if (!w) return; w.classList.toggle("open"); if (w.classList.contains("open")) buildModelMenu(); }
function closeModelMenu() { const w = modelWrap(); if (w) w.classList.remove("open"); }
function selectModel(id) {
  const s = curChat(); if (!s) return;
  s.model = id || "";
  closeModelMenu(); refreshLaneBar(); scheduleSave();
}
function buildLaneMenu() {
  const s = curChat(); const wrap = $("lanemenu"); if (!s || !wrap) return;
  const lanes = []; const seen = new Set(["board"]); // board listed separately under "Agent"
  for (const id of ["main", ...s.graph.laneOrder, s.activeLane]) {
    if (!id || seen.has(id)) continue; seen.add(id); lanes.push(id);
  }
  const boardActive = s.activeLane === "board";
  let h = `<div class="mhead">Agent</div>
    <div class="lanemenuitem${boardActive ? " active" : ""}" data-lane="board">
      <span class="sw" style="background:#b5791b"></span>
      <span class="nm">Board Helper</span><span class="sub">${boardActive ? "active" : "organizer"}</span></div>
    <div class="mhead">Lanes</div>`;
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
function closePlusMenu() { const w = plusWrap(); if (w) w.classList.remove("open"); }

// ---- Board Helper: parse + execute the organizer's board actions ---------

function nowClock() { const d = new Date(); return d.toTimeString().slice(0, 8); }

// pull the documented fenced ```board block out of the helper's reply. Use the
// LAST one (the system prompt says to put nothing after it), so an illustrative
// block earlier in the reply can't trigger execution.
function parseBoardBlock(text) {
  const re = /```board\s*([\s\S]*?)```/gi, s = String(text || "");
  let m, last = null;
  while ((m = re.exec(s))) last = m[1];
  if (last == null) return [];
  try { const v = JSON.parse(last.trim()); return Array.isArray(v) ? v : (v && Array.isArray(v.actions) ? v.actions : []); }
  catch { return []; }
}

function runBoardActions(actions, s) {
  if (!Array.isArray(actions) || !actions.length || !s) return;
  let noteX = 60, noteY = 60;
  for (const a of actions) {
    if (!a || typeof a !== "object") continue;
    if (a.action === "spawnLane" && a.prompt) {
      const laneId = "lane" + (s.graph.laneOrder.length + 1) + "-" + Math.random().toString(36).slice(2, 5);
      s.graph.beginLane(laneId, { model: s.graph.meta.model || "claude", mode: s.edits ? "bypass" : "ask" });
      if (s.graph.wtMap[laneId] && a.title) s.graph.wtMap[laneId].name = clip(a.title, 18);
      runQueue.push({ chatId: s.id, lane: laneId, prompt: String(a.prompt) });
      logs.push({ t: nowClock(), kind: "sys", text: `＋ Board Helper spawned ${clip(a.title || laneId, 24)}` });
    } else if (a.action === "note" && a.text) {
      const note = { id: "note" + Date.now().toString(36) + Math.random().toString(36).slice(2, 4), x: noteX, y: noteY, w: 190, text: String(a.text), color: "#fef6c7", pinned: true };
      s.notes.push(note); noteY += 92;
    } else if (a.action === "compact" && a.lane && s.graph.lanes[a.lane]) {
      s.graph.laneCompact[a.lane] = true;
    } else if (a.action === "focus") {
      if (a.lane && s.graph.lanes[a.lane] && s.graph.lanes[a.lane].headerId != null) canvas.zoomToNode(s.graph.lanes[a.lane].headerId, false);
      else if (a.query) canvas.search(String(a.query));
      logs.push({ t: nowClock(), kind: "sys", text: `◎ focus ${clip(a.query || a.lane || "", 24)}` });
    } else if (a.action === "search" && a.query) {
      canvas.search(String(a.query));
    } else if (a.action === "fit") {
      autoFit = false; canvas.fit();
    } else if (a.action === "arrange") {
      autoFit = false; canvas.arrange();
    }
  }
  if (canvas.model === s.graph) { canvas.setNotes(s.notes); canvas.sync(); }
  refreshLaneBar();
  scheduleSave();
}

// run the next Board-Helper-spawned lane (one turn at a time). Resilient to the
// user switching chats: jobs for absent chats are dropped, jobs for non-active
// chats wait (and resume when that chat is reopened — pump() is also called from
// switchSession), and the user's own lane selection is restored once drained.
function pump() {
  if (runningId) return;
  runQueue = runQueue.filter((j) => chatById(j.chatId));   // drop jobs for closed chats
  const s = curChat();
  if (runQueue.length && s) {
    const idx = runQueue.findIndex((j) => j.chatId === s.id);
    if (idx >= 0) {
      const job = runQueue.splice(idx, 1)[0];
      if (!queueReturnLane) queueReturnLane = { chatId: s.id, lane: s.activeLane };
      s.activeLane = job.lane;
      refreshLaneBar();
      sendPrompt(job.prompt);
      return;
    }
  }
  // nothing runnable now — if fully drained, restore the lane the user was on
  if (!runQueue.length && queueReturnLane) {
    const cs = chatById(queueReturnLane.chatId);
    if (cs) { cs.activeLane = queueReturnLane.lane; if (curChat() === cs) refreshLaneBar(); scheduleSave(); }
    queueReturnLane = null;
  }
}

// ---- Logs / Agents / Stats HUD -------------------------------------------

function logEvent(s, evt) {
  if (!evt) return;
  if (evt.type === "assistant") {
    for (const b of (evt.message?.content || [])) {
      if (b.type === "tool_use") logs.push({ t: nowClock(), kind: "tool", text: `${b.name}` });
    }
  } else if (evt.type === "result") {
    logs.push({ t: nowClock(), kind: evt.is_error ? "err" : "ok", text: `result · ${evt.num_turns || "?"} steps` });
  }
  if (logs.length > 500) logs = logs.slice(-400);
  if (hudOpen && hudTab === "logs") renderHud();
}

function toggleHud() {
  hudOpen = !hudOpen;
  $("hud").style.display = hudOpen ? "flex" : "none";
  $("panelbtn").classList.toggle("active", hudOpen);
  if (hudOpen) renderHud();
}
function setHudTab(tab) {
  hudTab = tab;
  document.querySelectorAll("#hudtabs button[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  renderHud();
}
function renderHud() {
  const body = $("hudbody"); if (!body) return;
  const s = curChat();
  if (hudTab === "logs") {
    body.innerHTML = `<div class="hudlog">${logs.slice(-200).map((l) =>
      `<div><span class="t">${l.t}</span> <span class="${l.kind === "err" ? "err" : l.kind === "ok" ? "ok" : ""}">${escapeHtml(l.text)}</span></div>`).join("") || "no activity yet"}</div>`;
    body.scrollTop = body.scrollHeight;
  } else if (hudTab === "agents") {
    let h = "";
    if (s) {
      for (const id of s.graph.laneOrder) {
        const lane = s.graph.lanes[id], wt = s.graph.wtMap[id];
        h += `<div class="hudrow"><span class="sw" style="background:${(wt && wt.color) || "var(--wt-main)"}"></span><span class="nm">${escapeHtml(laneLabel(s, id))}</span><span class="sub">${lane.turns} turn${lane.turns === 1 ? "" : "s"}</span></div>`;
      }
      for (const n of s.graph.nodes) if (n.type === "agent") {
        const wt = s.graph.wtMap[n.wt];
        h += `<div class="hudrow"><span class="sw" style="background:${(wt && wt.color) || "var(--wt-main)"}"></span><span class="nm">${escapeHtml(n.title)}</span><span class="sub">${n.status}</span></div>`;
      }
    }
    body.innerHTML = h || "no lanes yet";
  } else {
    let tools = 0, says = 0, results = 0;
    if (s) for (const n of s.graph.nodes) { if (n.type === "tool") tools++; if (n.type === "say") says++; if (n.type === "result") results++; }
    const st = s ? s.graph.stats() : null;
    const rows = [
      ["session cost", st && st.cost ? "$" + st.cost.toFixed(3) : "$0.000"],
      ["chats", sessions.length],
      ["turns (chat)", st ? st.turns : 0],
      ["lanes", s ? s.graph.laneOrder.length : 0],
      ["nodes", st ? st.nodes : 0],
      ["tool calls", tools],
      ["replies", says],
      ["results", results],
      ["queued runs", runQueue.length],
      ["running", st && st.busy ? "yes" : "no"],
    ];
    body.innerHTML = rows.map(([k, v]) => `<div class="hudstat"><span class="k">${escapeHtml(k)}</span><span class="v">${v}</span></div>`).join("");
  }
}

// ---- conversation + git panel (right side) -------------------------------

let panelOpen = false, panelTab = "chat";
function toggleChatPanel() {
  panelOpen = !panelOpen;
  $("chatpanel").classList.toggle("open", panelOpen);
  $("chatbtn").classList.toggle("active", panelOpen);
  if (panelOpen) { renderPanel(); updatePanelPrompt(); }
}
function setPanelTab(tab) {
  panelTab = tab;
  document.querySelectorAll("#cptabs button[data-cp]").forEach((b) => b.classList.toggle("active", b.dataset.cp === tab));
  const cb = $("chatbody"); if (cb) cb._sig = null;   // force a rebuild when switching tabs
  renderPanel();
  updatePanelPrompt();
}
// the in-panel composer shows only on the conversation tab (not git)
function updatePanelPrompt() { const p = $("cpprompt"); if (p) p.style.display = panelTab === "chat" ? "flex" : "none"; }
// send a message from inside the conversation panel — same path as the main bar
function cpSend() {
  const inp = $("cppromptinput"); const v = (inp.value || "").trim();
  if (!v) return;
  inp.value = "";
  sendPrompt(v);
}
function renderPanel() { if (!panelOpen) return; if (panelTab === "git") renderGitTree(); else renderConversation(); }
let cpOpenChat = null;
function renderConversation() {
  const host = $("chatbody"); const s = curChat(); if (!host) return;
  if (!s) { host.innerHTML = `<div class="empty-side">No chat selected.</div>`; host._sig = "none"; return; }
  // node ids restart at n0 per chat, so a stale expand-state would collide —
  // reset the open set whenever the rendered chat changes
  if (cpOpenChat !== s.id) { cpOpen.clear(); cpOpenChat = s.id; }
  // skip the full rebuild (and its scroll/selection reset) when nothing changed
  const nodes = s.graph.nodes;
  const sig = s.id + "|" + nodes.map((n) => n.id + (n.text ? n.text.length : 0) + (n.summary ? n.summary.length : 0) + (n.status || "") + (n.resultChip || "")).join(",");
  if (host._sig === sig) return;
  host._sig = sig;
  const nearBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 48;
  const prevTop = host.scrollTop;
  // a teleport-to-node affordance (Droolcat extra) shown on hover, top-right
  const go = (id) => `<button class="cc-go" data-go="${id}" title="show on board">⌖</button>`;
  let h = "";
  for (const n of nodes) {
    if (n.type === "lane") {
      if (n.lane === "main") continue;                       // main lane needs no divider
      h += `<div class="cc-lane">${escapeHtml(n.title || "lane")}</div>`;
    } else if (n.type === "prompt") {
      h += `<div class="cc-turn cc-user" data-go="${n.id}">${go(n.id)}<div class="cc-md">${mdChat(clip(n.text, 4000))}</div></div>`;
    } else if (n.type === "think") {
      if (!String(n.text || "").trim()) continue;
      h += `<div class="cc-turn cc-think" data-go="${n.id}">${go(n.id)}<div class="cc-think-h">✻ Thinking</div><div class="cc-md">${mdChat(n.text)}</div></div>`;
    } else if (n.type === "say") {
      if (!String(n.text || "").trim()) continue;            // skip empty stream placeholders
      h += `<div class="cc-turn cc-assistant" data-go="${n.id}">${go(n.id)}<div class="cc-md">${mdChat(n.text)}${n.status === "run" ? '<span class="cc-caret"></span>' : ""}</div></div>`;
    } else if (n.type === "tool" || n.type === "agent") {
      h += ccAction(n, go);
    } else if (n.type === "result") {
      const err = n.donePill && n.donePill.k === "danger";
      if (n.meta || err) h += `<div class="cc-result${err ? " err" : ""}" data-go="${n.id}"><span class="cc-rmeta">${err ? "✗" : "✓"}&nbsp; ${escapeHtml(n.meta || (err ? "Failed" : "Done"))}</span>${go(n.id)}</div>`;
    }
  }
  host.innerHTML = h || `<div class="empty-side">No messages yet.</div>`;
  host.querySelectorAll(".cc-go").forEach((el) =>
    el.addEventListener("click", (e) => { e.stopPropagation(); if (canvas.model === s.graph) canvas.zoomToNode(el.dataset.go); }));
  // the › disclosure on a tool/action line expands its detail inline (like the app)
  host.querySelectorAll(".cc-act-x").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    const id = b.dataset.exp;
    const act = b.closest(".cc-act"); const d = act && act.querySelector(".cc-act-d");
    const open = !cpOpen.has(id);
    if (open) cpOpen.add(id); else cpOpen.delete(id);
    if (d) d.hidden = !open;
    b.classList.toggle("open", open);
  }));
  host.scrollTop = nearBottom ? host.scrollHeight : prevTop;  // keep your place if you scrolled up
}
// which tool/action lines are expanded in the panel (persists across re-renders)
const cpOpen = new Set();
// render a tool/agent node as the Claude Code app's muted, collapsed one-line
// summary with a › disclosure (e.g. "Edited canvas.js +7 −4 ›") instead of the
// terminal bullet style.
function ccAction(n, go) {
  const open = cpOpen.has(n.id);
  if (n.kind === "todo") {
    const todos = n.detail && n.detail.input && n.detail.input.todos;
    const done = Array.isArray(todos) ? todos.filter((t) => t.status === "completed").length : 0;
    const total = Array.isArray(todos) ? todos.length : 0;
    return `<div class="cc-act" data-go="${n.id}"><div class="cc-act-line"><span class="cc-act-v">Updated</span> <span class="cc-act-t">todos</span> <span class="cc-act-meta">${done}/${total}</span><span class="cc-sp"></span>${go(n.id)}<button class="cc-act-x${open ? " open" : ""}" data-exp="${n.id}" title="expand">›</button></div><div class="cc-act-d"${open ? "" : " hidden"}>${ccTodoList(todos)}</div></div>`;
  }
  const sum = ccActionSummary(n);
  const detail = ccActionDetail(n);
  const chev = detail ? `<button class="cc-act-x${open ? " open" : ""}" data-exp="${n.id}" title="expand">›</button>` : "";
  const det = detail ? `<div class="cc-act-d"${open ? "" : " hidden"}>${detail}</div>` : "";
  const run = n.status === "run" ? `<span class="cc-act-run">●</span>` : "";
  const err = n.donePill && n.donePill.k === "danger" ? " err" : "";
  return `<div class="cc-act${err}" data-go="${n.id}"><div class="cc-act-line"><span class="cc-act-v">${sum.verb}</span> <span class="cc-act-t">${sum.target}</span>${sum.stat}${run}<span class="cc-sp"></span>${go(n.id)}${chev}</div>${det}</div>`;
}
function ccActionSummary(n) {
  const f = n.file ? clip(n.file, 50) : "";
  let verb, target;
  switch (n.kind) {
    case "read": verb = "Read"; target = f; break;
    case "edit": verb = "Edited"; target = f; break;
    case "write": verb = "Wrote"; target = f; break;
    case "bash": verb = "Ran"; target = f || (n.detail && n.detail.input && n.detail.input.command ? clip(n.detail.input.command, 50) : "command"); break;
    case "search": verb = "Searched"; target = f || "the codebase"; break;
    case "web": verb = "Fetched"; target = f; break;
    case "mcp": verb = "Used"; target = (f ? clip(f, 22) + " · " : "") + ccCap(n.title); break;
    default:
      if (n.type === "agent") { verb = "Task"; target = clip(n.title, 46); }
      else { verb = ccCap(n.title); target = f; }
  }
  let stat = "";
  if (n.kind === "edit" && n.resultChip) {
    const m = String(n.resultChip).match(/\+(\d+)\s*[−-]\s*(\d+)/);
    if (m) stat = ` <span class="cc-add">+${m[1]}</span> <span class="cc-rm">−${m[2]}</span>`;
  }
  return { verb: escapeHtml(verb), target: escapeHtml(target || ""), stat };
}
function ccActionDetail(n) {
  const diff = n.detail && n.detail.diff;
  if (Array.isArray(diff) && diff.length) {
    return `<div class="cc-diff-box">${diff.slice(0, 60).map((r) => `<div class="cc-diff ${r[0] === "ad" ? "ad" : "rm"}">${escapeHtml(clip(r[1] || "", 90))}</div>`).join("")}${diff.length > 60 ? `<div class="cc-diff-more">…+${diff.length - 60} more</div>` : ""}</div>`;
  }
  const out = n.detail && n.detail.out;
  if (out) return `<pre class="cc-out">${escapeHtml(clip(String(out), 1400))}</pre>`;
  if (n.type === "agent" && n.detail && n.detail.think) return `<div class="cc-out">${escapeHtml(clip(String(n.detail.think), 700))}</div>`;
  if (n.donePill) return `<div class="cc-out cc-dim">${escapeHtml(n.donePill.l)}</div>`;
  return "";
}
// Claude Code shows tool names capitalized (Read, Edit, Bash…); collapse the
// noisy mcp__server__tool form down to just the tool segment
function ccCap(t) {
  t = String(t || "");
  if (t.includes("__")) t = t.split("__").filter(Boolean).pop();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}
// colored status dot for a tool/agent line — green done, red error, amber running
function ccBulletClass(n) {
  if (n.donePill && n.donePill.k === "danger") return "err";
  if (n.status === "run") return "run";
  return "ok";
}
// the "⎿ …" continuation line under a tool, mirroring the CLI's result preview
function ccToolResult(n) {
  // edits: show the CLI-style "⎿ +N −M" plus a few colored diff rows
  const diff = n.detail && n.detail.diff;
  if (Array.isArray(diff) && diff.length) {
    const rows = diff.slice(0, 6).map((r) => `<div class="cc-diff ${r[0] === "ad" ? "ad" : "rm"}">${escapeHtml(clip(r[1] || "", 70))}</div>`).join("");
    const more = diff.length > 6 ? `<div class="cc-diff-more">…+${diff.length - 6} more</div>` : "";
    return `<div class="cc-tres">⎿&nbsp; ${escapeHtml(n.resultChip || "edited")}</div><div class="cc-diff-box">${rows}${more}</div>`;
  }
  if (n.kind === "bash" && n.donePill) return `<div class="cc-tres">⎿&nbsp; ${escapeHtml(n.donePill.l)}</div>`;
  if (n.resultChip) return `<div class="cc-tres">⎿&nbsp; ${escapeHtml(n.resultChip)}</div>`;
  const out = n.detail && n.detail.out;
  if (out) {
    if (n.kind === "search") {
      const matches = String(out).split("\n").filter((l) => l.trim()).length;
      return `<div class="cc-tres">⎿&nbsp; Found ${matches} ${matches === 1 ? "match" : "matches"}</div>`;
    }
    const first = String(out).split("\n").find((l) => l.trim()) || "";
    return `<div class="cc-tres">⎿&nbsp; ${escapeHtml(clip(first, 80))}</div>`;
  }
  if (n.status === "run") return `<div class="cc-tres cc-dim">⎿&nbsp; running…</div>`;
  return "";
}
function ccTodoList(todos) {
  const list = Array.isArray(todos) ? todos : [];
  const items = list.slice(0, 20).map((t) => {
    const st = t.status || "pending";
    const box = st === "completed" ? "☒" : "☐";
    const label = st === "in_progress" ? (t.activeForm || t.content) : t.content;
    return `<div class="cc-td ${st === "completed" ? "done" : st === "in_progress" ? "active" : ""}">${box}&nbsp; ${escapeHtml(label || "")}</div>`;
  }).join("");
  return `<div class="cc-todos">${items}</div>`;
}
async function renderGitTree() {
  const host = $("chatbody"); const s = curChat();
  const dir = (s && s.cwd) || (s && s.graph.meta && s.graph.meta.cwd) || "";
  const t = await getTauri();
  if (!t) { host.innerHTML = `<div class="empty-side">The git tree is available in the desktop app.</div>`; return; }
  if (!dir) { host.innerHTML = `<div class="empty-side">Set a working folder (＋) to see its git history.</div>`; return; }
  host.innerHTML = `<div class="empty-side">Reading git history…</div>`;
  try {
    const commits = await t.invoke("git_graph", { cwd: dir, limit: 60 });
    if (panelTab !== "git") return;
    if (!commits || !commits.length) { host.innerHTML = `<div class="empty-side">No commits.</div>`; return; }
    host.innerHTML = commits.map((c, i) => {
      const refs = (c.refs || "").split(",").map((r) => r.trim()).filter((r) => r && r !== "HEAD");
      const ref = refs.map((r) => `<span class="gitref">${escapeHtml(r.replace("HEAD -> ", "").replace("tag: ", "⌖ "))}</span>`).join("");
      return `<div class="gitrow${i === 0 ? " head" : ""}"><div class="gitrail"><div class="gitdot"></div></div>
        <div class="gitmeta"><div class="gitmsg">${ref}${escapeHtml(c.subject)}</div>
        <div class="gitsub">${escapeHtml(c.short)} · ${escapeHtml(c.author)} · ${escapeHtml(c.when)}</div></div></div>`;
    }).join("");
  } catch (e) { host.innerHTML = `<div class="empty-side">${escapeHtml(String(e))}</div>`; }
}

// ---- board search controls -----------------------------------------------

function toggleSearch() {
  const b = $("searchbar");
  const show = b.style.display === "none";
  if (show) { b.style.display = "flex"; $("findbtn").classList.add("active"); $("searchinput").focus(); $("searchinput").select(); if ($("searchinput").value) updateSearchCount(canvas.search($("searchinput").value)); }
  else closeSearch();
}
function closeSearch() {
  $("searchbar").style.display = "none";
  $("findbtn").classList.remove("active");
  canvas.clearSearch();
}
function updateSearchCount(n) {
  const q = $("searchinput").value.trim();
  const idx = canvas._searchIdx >= 0 ? canvas._searchIdx + 1 : 0;
  $("scount").textContent = !q ? "" : (n ? `${idx}/${n}` : "0/0");
}

// ---- command palette (Ctrl/Cmd-K) ----------------------------------------

let palItems = [], palSel = 0;
function paletteCommands() {
  return [
    { sec: "Actions", label: "New chat", run: () => newSession() },
    { sec: "Actions", label: "New agent lane", run: () => newLane() },
    { sec: "Actions", label: "Talk to the Board Helper", run: () => { if (!curChat()) newSession(); selectLane("board"); } },
    { sec: "Actions", label: "Find on board", run: () => toggleSearch() },
    { sec: "Actions", label: "Fit board to content", run: () => canvas.fit() },
    { sec: "Actions", label: "Jump to latest", run: () => canvas.goLatest() },
    { sec: "Actions", label: "Tidy the board (arrange)", run: () => canvas.arrange() },
    { sec: "Actions", label: "Voice mode", run: () => voice.enter() },
    { sec: "Actions", label: "Toggle logs / agents / stats", run: () => toggleHud() },
    { sec: "Actions", label: "Code graph on the board", run: () => switchView("code") },
    { sec: "Actions", label: "Back to agents view", run: () => switchView("agents") },
    { sec: "Actions", label: "Refresh Claude Code sessions", run: () => loadCcSessions() },
    { sec: "Actions", label: "Companion — Claude app + live mirror", run: () => startCompanionApp() },
    { sec: "Actions", label: "Companion — new claude terminal", run: () => startCompanion() },
  ];
}
function buildPaletteItems(q) {
  q = (q || "").toLowerCase().trim();
  const chats = sessions.map((s, i) => ({ sec: "Chats", label: s.title || "chat", hint: s.observed ? "live" : (s.graph.turnCount + "t"), run: () => switchSession(i) }));
  const all = [...paletteCommands(), ...chats];
  if (!q) return all.slice(0, 40);
  const direct = all.filter((it) => it.label.toLowerCase().includes(q));
  // cross-chat CONTENT search — look inside every chat's nodes, jump to the hit
  const content = [];
  for (let i = 0; i < sessions.length && content.length < 14; i++) {
    const s = sessions[i];
    for (const n of s.graph.nodes) {
      const hay = String(n.text || n.summary || n.file || (n.type !== "lane" ? n.title : "") || "");
      const idx = hay.toLowerCase().indexOf(q);
      if (idx >= 0) {
        const snippet = hay.slice(Math.max(0, idx - 16), idx + 46).replace(/\s+/g, " ").trim();
        content.push({ sec: "Found in chats", label: snippet || (s.title || "chat"), hint: clip(s.title || "chat", 16), run: () => { switchSession(i); setTimeout(() => { if (canvas.model === s.graph) canvas.zoomToNode(n.id); }, 60); } });
        break;   // one hit per chat keeps the list scannable
      }
    }
  }
  return [...direct, ...content].slice(0, 40);
}
function openPalette() {
  $("palette").style.display = "flex";
  $("palinput").value = "";
  renderPalette("");
  setTimeout(() => $("palinput").focus(), 0);
}
function closePalette() { $("palette").style.display = "none"; }
function renderPalette(q) {
  palItems = buildPaletteItems(q);
  palSel = 0;
  const host = $("pallist"); host.innerHTML = "";
  let lastSec = "";
  palItems.forEach((it, i) => {
    if (it.sec !== lastSec) { lastSec = it.sec; const sc = document.createElement("div"); sc.className = "palsec"; sc.textContent = it.sec; host.appendChild(sc); }
    const d = document.createElement("div");
    d.className = "palitem" + (i === palSel ? " sel" : "");
    d.dataset.i = i;
    d.innerHTML = `<span class="pi-l">${escapeHtml(it.label)}</span>${it.hint ? `<span class="pi-h">${escapeHtml(it.hint)}</span>` : ""}`;
    d.onmousedown = (e) => { e.preventDefault(); runPalette(i); };
    d.onmousemove = () => { if (palSel !== i) { palSel = i; [...host.querySelectorAll(".palitem")].forEach((el) => el.classList.toggle("sel", +el.dataset.i === palSel)); } };
    host.appendChild(d);
  });
}
function movePalette(d) {
  if (!palItems.length) return;
  palSel = (palSel + d + palItems.length) % palItems.length;
  [...$("pallist").querySelectorAll(".palitem")].forEach((el) => el.classList.toggle("sel", +el.dataset.i === palSel));
  const sel = $("pallist").querySelector(".palitem.sel"); if (sel) sel.scrollIntoView({ block: "nearest" });
}
function runPalette(i) {
  const it = palItems[i]; if (!it) return;
  closePalette();
  try { it.run(); } catch (e) { console.warn("palette action failed", e); }
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
        id: s.id, title: s.title, cwd: s.cwd, edits: s.edits, activeLane: s.activeLane, model: s.model || "",
        laneClaudeId: s.laneClaudeId, notes: s.notes, observed: s.observed || null, graph: s.graph.toJSON(),
      })),
    };
    localStorage.setItem(STORE, JSON.stringify(data));
    saveWarned = false;
  } catch (e) {
    console.warn("save failed", e);
    if (!saveWarned) { saveWarned = true; toast("Couldn't save — local storage is full. Delete old chats to free space.", { kind: "err", timeout: 8000 }); }
  }
}
let saveWarned = false;
function loadSessions() {
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) return false;
    const d = JSON.parse(raw);
    if (!d || !Array.isArray(d.sessions) || !d.sessions.length) return false;
    sessions = d.sessions.map((s) => ({
      id: s.id, title: s.title || "chat", cwd: s.cwd || "", edits: s.edits !== false,
      activeLane: s.activeLane || "main", laneClaudeId: s.laneClaudeId || {},
      notes: Array.isArray(s.notes) ? s.notes : [], observed: s.observed || null,
      model: s.model || "", graph: new GraphModel().fromJSON(s.graph),
    }));
    cur = Math.min(Math.max(0, d.cur || 0), sessions.length - 1);
    return true;
  } catch (e) { console.warn("load failed", e); return false; }
}
function clip(s, n) { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; }

// A chat counts as a throwaway greeting if every prompt is a bare hello AND it
// did no real work (no tools/subagents). The website chat survives — it starts
// with "hi" but has tool calls and a real prompt.
// only UNAMBIGUOUS greetings — dropped "test/gm/gn/yo/sup" since those are
// plausibly real chat topics and auto-deleting them would lose real work
const GREETING = /^\s*(hi+|h?ey+|he?llo+|heya|hiya|howdy|good\s*(morning|afternoon|evening))[\s!.,?]*$/i;
function isGreetingOnly(s) {
  const g = s.graph;
  if (g.nodes.some((n) => n.type === "tool" || n.type === "agent")) return false;
  const prompts = g.nodes.filter((n) => n.type === "prompt");
  if (!prompts.length) return false;                       // empty/new chat — leave it
  return prompts.every((p) => GREETING.test(p.text || ""));
}
// a throwaway "hi" chat: named like a greeting AND it did no real work (no
// tool/subagent nodes). Title-based so "hi" chats with a trivial extra reply
// still qualify; the no-work guard protects anything substantive.
function isThrowawayGreeting(s) {
  if (s.titleEdited) return false;                                      // user named it on purpose
  if (s.graph.nodes.some((n) => n.type === "tool" || n.type === "agent")) return false;
  if (s.graph.turnCount > 1) return false;                             // a real back-and-forth, not a throwaway
  return GREETING.test(s.title || "");
}
// run on EVERY launch (not one-shot) so accumulated "hi" test chats keep getting
// cleaned. Only greeting-named, no-work chats are removed; real work survives.
function pruneGreetingChats() {
  const curId = cur >= 0 && sessions[cur] ? sessions[cur].id : null;
  const before = sessions.length;
  sessions = sessions.filter((s) => !isThrowawayGreeting(s));
  const removed = before - sessions.length;
  if (removed) {
    cur = curId ? sessions.findIndex((x) => x.id === curId) : 0;
    if (cur < 0) cur = 0;
    saveSessions();
    console.log(`[droolcat] removed ${removed} greeting chat(s)`);
  }
  return removed;
}

// ---- toolbar / prompt events --------------------------------------------

document.querySelectorAll("#srcsel button").forEach((b) =>
  b.onclick = () => { if (!b.disabled) setSource(b.dataset.src); });
document.querySelectorAll("#viewsel button").forEach((b) =>
  b.onclick = () => switchView(b.dataset.view));
$("send").onclick = () => fireSend();
// Enter sends, Shift+Enter inserts a newline (matches Claude Code + the panel composer)
$("prompt").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); fireSend(); } });
$("prompt").addEventListener("input", autoGrowPrompt);
function fireSend() {
  const i = $("prompt"), v = i.value.trim();
  if (!v && source !== "sample") return;
  i.value = "";
  autoGrowPrompt();
  sendPrompt(v);
}
$("newsession").onclick = () => newSession();
$("newsession").onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); newSession(); } };
$("ccrefresh").onclick = () => loadCcSessions();
$("folder").addEventListener("change", () => { const s = curChat(); if (s) { s.cwd = $("folder").value.trim(); scheduleSave(); } });
$("allowedits").addEventListener("change", () => { const s = curChat(); if (s) { s.edits = $("allowedits").checked; refreshLaneBar(); scheduleSave(); } });
$("lanebtn").onclick = (e) => { e.stopPropagation(); closePlusMenu(); toggleLaneMenu(); };
$("pbnew").onclick = (e) => { e.stopPropagation(); closeLaneMenu(); const w = plusWrap(); if (w) w.classList.toggle("open"); };
$("plusnewlane").onclick = (e) => { e.stopPropagation(); closePlusMenu(); newLane(); };
$("pluscompanionapp").onclick = (e) => { e.stopPropagation(); startCompanionApp(); };
$("pluscompanion").onclick = (e) => { e.stopPropagation(); startCompanion(); };
$("pbmic").onclick = () => voice.enter();
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && voice.active) voice.exit(); });
$("pbmode").onclick = () => { const s = curChat(); if (!s) return; s.edits = !s.edits; $("allowedits").checked = s.edits; refreshLaneBar(); scheduleSave(); };
$("pbmodel").onclick = (e) => { e.stopPropagation(); closeLaneMenu(); closePlusMenu(); toggleModelMenu(); };
$("panelbtn").onclick = () => toggleHud();
$("companionbtn").onclick = () => startCompanionApp();
$("chatbtn").onclick = () => toggleChatPanel();
$("chatclose").onclick = () => toggleChatPanel();
document.querySelectorAll("#cptabs button[data-cp]").forEach((b) => b.onclick = () => setPanelTab(b.dataset.cp));
$("cpsend").onclick = () => cpSend();
$("cppromptinput").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); cpSend(); } });
$("hudclose").onclick = () => toggleHud();
document.querySelectorAll("#hudtabs button[data-tab]").forEach((b) => b.onclick = () => setHudTab(b.dataset.tab));
document.addEventListener("click", (e) => {
  const lw = laneWrap(); if (lw && lw.classList.contains("open") && !lw.contains(e.target)) closeLaneMenu();
  const pw = plusWrap(); if (pw && pw.classList.contains("open") && !pw.contains(e.target)) closePlusMenu();
  const mw = modelWrap(); if (mw && mw.classList.contains("open") && !mw.contains(e.target)) closeModelMenu();
});
// command palette
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) { e.preventDefault(); if (voice.active) return; $("palette").style.display === "none" ? openPalette() : closePalette(); }
  else if (e.key === "Escape" && $("palette").style.display !== "none") closePalette();
});
$("palinput").addEventListener("input", () => renderPalette($("palinput").value));
$("palinput").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); movePalette(1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); movePalette(-1); }
  else if (e.key === "Enter") { e.preventDefault(); runPalette(palSel); }
});
$("palette").addEventListener("mousedown", (e) => { if (e.target.id === "palette") closePalette(); });
$("stopbtn").onclick = stopTurn;
$("zin").onclick = () => { setFollow(false); canvas.zoom(1.15); };
$("zout").onclick = () => { setFollow(false); canvas.zoom(1 / 1.15); };
$("fit").onclick = () => canvas.fit();
$("tolatest").onclick = () => canvas.goLatest();
$("followbtn").onclick = () => { setFollow(!autoFit); if (autoFit) canvas.goLatest(); };
$("findbtn").onclick = () => toggleSearch();
$("sclose").onclick = () => closeSearch();
$("snext").onclick = () => updateSearchCount(canvas.nextHit(1));
$("sprev").onclick = () => updateSearchCount(canvas.nextHit(-1));
$("searchinput").addEventListener("input", () => updateSearchCount(canvas.search($("searchinput").value)));
$("searchinput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") updateSearchCount(canvas.nextHit(e.shiftKey ? -1 : 1));
  if (e.key === "Escape") closeSearch();
});
$("replay").onclick = () => { if (source === "sample") replaySampleTurn(); else replaySampleTurn(); };
$("viewport").addEventListener("mousedown", () => { setFollow(false); });

// ---- boot ---------------------------------------------------------------

if (loadSessions()) {
  const pruned = pruneGreetingChats();                   // one-time: remove the "hi" chats
  if (!sessions.length) newSession();
  else switchSession(Math.min(Math.max(0, cur), sessions.length - 1));
  if (pruned) setConn(tauri ? "live" : "", `removed ${pruned} greeting-only chat${pruned > 1 ? "s" : ""}`);
} else newSession();                                      // or start fresh
window.addEventListener("beforeunload", saveSessions);
wireBridge();
loadCcSessions();   // populate the Claude Code session list (desktop app only)
wireSidebarResize();
updateFollowBtn();  // reflect the initial follow state on the toolbar toggle

// dev/preview-only test hook (gated to the Vite port; inert in the packaged app)
if (location.port === "1420") {
  window.__droolcat = {
    parseBoardBlock, runBoardActions, curChat: () => curChat(), canvas,
    logs: () => logs, runQueue: () => runQueue, voice,
    parseJsonl, trimToLastTurns, newGraph: () => new GraphModel(),
    isGreetingOnly: (g) => isGreetingOnly({ graph: g }),
    pruneTest: (sess) => { sessions = sess; cur = 0; try { localStorage.removeItem("droolcat.pruned.greetings.v1"); } catch {} const removed = pruneGreetingChats(); return { removed, remaining: sessions.map((s) => s.title) }; },
    testIngest: (objs) => { const g = new GraphModel(); g.ingestTranscript(objs); return { nodes: g.nodes.length, turns: g.turnCount, types: g.nodes.reduce((a, n) => { a[n.type] = (a[n.type] || 0) + 1; return a; }, {}), edges: g.edges.length }; },
    reset: () => { sessions.length = 0; cur = -1; localStorage.removeItem(STORE); location.reload(); },
  };
}
