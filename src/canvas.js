// canvas.js — renders the GraphModel as a pan/zoom spatial tree.
// Pure presentation: it reads nodes/edges (already laid out by graph.js),
// reconciles DOM, animates status, and owns the camera + inspector.

import { I, KIC } from "./icons.js";
import { SIZES, layout } from "./graph.js";

const WT_FALLBACK = {
  main: { name: "main", color: "var(--wt-main)" },
  frontend: { name: "wt/frontend", color: "var(--wt-frontend)" },
  api: { name: "wt/api", color: "var(--wt-api)" },
  tests: { name: "wt/tests", color: "var(--wt-tests)" },
};
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

// light, safe markdown -> HTML for Claude Code output (escape first, then format)
function mdToHtml(s) {
  s = esc(String(s || ""));
  s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _l, c) => `<pre>${c.replace(/\n+$/, "")}</pre>`);
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/^(#{1,4})\s+(.+)$/gm, "<b>$2</b>");
  return s;
}

export class Canvas {
  constructor(els, { onSteer, onNewLane, onPersist, onCompact, onUserCam, onLaneSelect } = {}) {
    this.world = els.world;
    this.edgesSvg = els.edges;
    this.viewport = els.viewport;
    this.inspector = els.inspector;
    this.inwrap = els.inwrap;
    this.headpill = els.headpill;
    this.target = els.target || null;
    this.empty = els.empty;
    this.zl = els.zl;
    this.onSteer = onSteer;
    this.onNewLane = onNewLane;
    this.onPersist = onPersist;
    this.onCompact = onCompact;
    this.onUserCam = onUserCam;       // user grabbed the camera -> stop auto-follow
    this.onLaneSelect = onLaneSelect; // clicked a lane header -> make it the active lane

    this.model = null;
    this.els = {};        // node id -> DOM el
    this.edgeEls = {};     // edge key -> path
    this.aux = null;       // auxiliary model (code graph) rendered as a board cluster
    this.auxEls = {};      // "aux:"+id -> DOM el
    this.auxEdgeEls = {};  // "aux:"+key -> path
    this.auxOrigin = { x: 0, y: 0 };
    this.clusterLabelEl = null;
    this.notes = [];       // sticky notes (Miro board)
    this.noteEls = {};
    this.cam = { x: 120, y: 60, s: 1 };
    this.selected = null;
    this.selWt = null;
    this.searchHits = [];   // node ids matching the current board search
    this._searchIdx = -1;

    this._wireCamera(els);
    this._initBoard();     // right-click menu + minimap
  }

  setModel(m) { this.model = m; }
  setNotes(notes) {
    this.notes = notes || [];
    for (const id in this.noteEls) { this.noteEls[id].remove(); delete this.noteEls[id]; }
    this._renderNotes();
  }

  // (re)build DOM from the model, animating in new nodes
  sync() {
    const m = this.model;
    if (!m) return;
    const live = new Set(m.nodes.map((n) => n.id));

    // drop stale
    for (const id in this.els) if (!live.has(id)) { this.els[id].remove(); delete this.els[id]; }
    for (const k in this.edgeEls) {
      const [a, b] = k.split(">");
      if (!live.has(a) || !live.has(b)) { this.edgeEls[k].remove(); delete this.edgeEls[k]; }
    }

    const compactOf = (n) => !!(m.laneCompact && m.laneCompact[n.lane]) && (n.type === "tool" || n.type === "say" || n.type === "agent");
    for (const n of m.nodes) {
      let el = this.els[n.id];
      if (!el) {
        el = document.createElement("div");
        if (n.type === "lane") this._wireLane(el, n);
        else el.addEventListener("click", (e) => { e.stopPropagation(); this.select(n.id); });
        el.addEventListener("dblclick", (e) => { e.stopPropagation(); this.zoomToNode(n.id); });
        this.world.appendChild(el);
        this.els[n.id] = el;
      }
      // base class is set once; render() owns the state classes (show/running/sel/dim)
      const base = "cnode t-" + n.type + (n.kind ? " k-" + n.kind : "") + (n.helper ? " helper" : "");
      if (el._base !== base) { el.className = base; el._base = base; }
      // compact must be applied BEFORE we measure heights, so the layout reflows
      const compact = compactOf(n);
      if (el._compact !== compact) { el.classList.toggle("compact", compact); el._compact = compact; }
      const sig = `${n.type}|${n.kind || ""}|${n.status}|${n.title}|${n.file || ""}|${n.text || ""}|${n.thought || ""}|${n.donePill ? n.donePill.l : ""}|${n.summary ? n.summary.length : 0}|${n.meta || ""}|${n.model || ""}|${n.mode || ""}|${n.ctx || ""}|${n.turns || 0}|${n.expanded ? 1 : 0}|${n.collapsed ? 1 : 0}|${this.searchHits && this.searchHits.includes(n.id) ? 1 : 0}`;
      if (el._sig !== sig) {
        el.innerHTML = this._card(n);
        el._sig = sig;
        if (n.type === "result" || n.type === "say") {
          const b = el.querySelector(".outbtn");
          if (b) b.addEventListener("click", (e) => {
            e.stopPropagation();
            if (n.type === "result") { const big = String(n.summary || "").length > 1500; n.collapsed = !(n.collapsed == null ? big : n.collapsed); }
            else n.expanded = !n.expanded;
            el._sig = null; this.sync();
          });
        }
        if (n.type === "lane") {
          const c = el.querySelector(".lane-compact");
          if (c) c.addEventListener("click", (e) => { e.stopPropagation(); this.onCompact && this.onCompact(n.lane); });
        }
      }
    }

    for (const e of m.edges) {
      const key = e.from + ">" + e.to;
      if (!this.edgeEls[key]) {
        const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
        p.setAttribute("class", "cedge" + (e.cross ? " cross" : ""));
        this.edgesSvg.appendChild(p);
        this.edgeEls[key] = p;
      }
    }

    // measure each card's ACTUAL rendered height and re-lay-out from it, so
    // tight content doesn't leave a gap (line starting in empty space) and long
    // content doesn't overlap. Only for the agent graph (cards vary by text).
    if (typeof m.beginTurn === "function") {
      for (const n of m.nodes) {
        const el = this.els[n.id]; if (el) el.style.width = ((SIZES[n.type] || SIZES.tool).w) + "px";
      }
      void this.world.offsetHeight;
      for (const n of m.nodes) {
        const el = this.els[n.id]; if (el) n.h = el.offsetHeight;
      }
      layout(m);
    }

    this._syncAux();

    if (this.empty) this.empty.classList.toggle("hide", m.nodes.length > 0 || (this.aux && this.aux.nodes.length > 0));
    // force a reflow so freshly-appended nodes transition in (no rAF dependency —
    // the window may be backgrounded, where rAF is throttled to never)
    void this.world.offsetHeight;
    this.render();
  }

  render() {
    const m = this.model;
    if (!m) return;
    let maxX = 0, maxY = 0;
    for (const n of m.nodes) {
      const el = this.els[n.id]; if (!el) continue;
      el.style.cssText = `left:${n.x}px;top:${n.y}px;width:${n.w}px`;
      el.classList.add("show");
      el.classList.toggle("running", n.status === "run");
      el.classList.toggle("sel", n.id === this.selected);
      el.classList.toggle("touched", !!n.touched);
      el.classList.toggle("dim", !!(this.selWt && n.wt && n.wt !== this.selWt));
      el.classList.toggle("hit", this.searchHits.length > 0 && this.searchHits.includes(n.id));
      this._pill(el, n);
      maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + n.h);
    }
    if (this.aux) for (const n of this.aux.nodes) { maxX = Math.max(maxX, this.auxOrigin.x + n.x + n.w); maxY = Math.max(maxY, this.auxOrigin.y + n.y + n.h); }
    this.world.style.width = maxX + 240 + "px";
    this.world.style.height = maxY + 200 + "px";
    this.edgesSvg.setAttribute("width", maxX + 240);
    this.edgesSvg.setAttribute("height", maxY + 200);

    for (const e of m.edges) {
      const p = this.edgeEls[e.from + ">" + e.to];
      const a = m.byId[e.from], b = m.byId[e.to];
      if (!p || !a || !b) continue;
      p.setAttribute("d", this._path(a, b));
      p.classList.add("on");
    }
    this._renderAux();

    // header pill
    const s = m.stats();
    if (this.headpill) {
      if (m.headline) {
        this.headpill.className = "aw-pill";
        this.headpill.textContent = m.headline;
      } else if (s.busy) {
        this.headpill.className = "aw-pill p-info";
        this.headpill.textContent = "working…";
      } else if (s.turns > 0) {
        this.headpill.className = "aw-pill p-success";
        this.headpill.textContent = `${s.turns} turn${s.turns > 1 ? "s" : ""}`;
      } else {
        this.headpill.className = "aw-pill"; this.headpill.textContent = "";
      }
    }
    this._renderNotes();
    this._renderMinimap();
  }

  _pill(el, n) {
    const pl = el.querySelector(".pill"); if (!pl) return;
    let k, l;
    if (n.status === "run") {
      k = "info";
      l = n.type === "tool"
        ? ({ read: "reading…", edit: "writing…", write: "writing…", bash: "running", search: "searching…", web: "fetching…" }[n.kind] || "running")
        : n.type === "agent" ? "running" : "running";
    } else if (n.status === "pend") { k = "warning"; l = "queued"; }
    else if (n.donePill) { k = n.donePill.k; l = n.donePill.l; }
    else { k = "success"; l = "done"; }
    pl.className = "aw-pill pill p-" + k;
    pl.textContent = l;
  }

  _card(n) {
    const pill = `<span class="aw-pill pill"></span>`;
    if (n.type === "lane") {
      const modeK = n.mode === "bypass" ? "p-warning" : "";
      const modeL = n.mode === "bypass" ? "bypass perms" : "ask perms";
      const st = n.status === "wait"
        ? `<span class="aw-pill p-info">waiting for input</span>`
        : n.status === "run"
          ? `<span class="aw-pill p-info">running…</span>`
          : `<span class="aw-pill p-success">${n.turns || 0} turn${(n.turns || 0) === 1 ? "" : "s"}</span>`;
      const ctx = n.ctx ? `<span class="lane-ctx">${esc(n.ctx)} ctx</span>` : "";
      return `<div class="lane-head"><span class="sw" style="background:${this._wtColor(n.wt)}"></span>
        <span class="lbl">${esc(n.title || "Agent lane")}</span>
        <button class="lane-compact" title="compact this lane">${I.compact}</button></div>
        <div class="lane-meta"><span class="lane-model">${esc(n.model || "claude")}</span><span class="aw-pill ${modeK}">${modeL}</span>${ctx}</div>
        <div class="lane-status">${st}</div>`;
    }
    if (n.type === "prompt")
      return `<div class="row"><span class="aw-ic">${I.user}</span><span class="lbl">You</span><span class="meta" style="margin-left:auto">turn ${n.turn || 1}</span></div>
        <div class="prompttext">${esc(n.text || "")}</div>`;
    if (n.type === "say") {
      const long = (n.text || "").length > 600; // ~ the 14-line clamp; only show when expanding reveals more
      const btn = long ? `<button class="outbtn">${n.expanded ? "▴ less" : "▾ more"}</button>` : "";
      return `<div class="row"><span class="aw-ic">${I.orch}</span><span class="lbl">Claude</span></div>
        <div class="saytext${n.expanded ? " expanded" : ""}">${esc(n.text || "")}${n.status === "run" ? '<span class="caret"></span>' : ""}</div>${btn}`;
    }
    if (n.type === "orch")
      return `<div class="row"><span class="aw-ic">${I.orch}</span><span class="lbl">${esc(n.title)}</span>${pill}</div>
        <div class="osub" style="margin-top:5px">${esc(n.sub || "")}</div>
        <div class="think one">${esc(n.thought || "")}</div>`;
    if (n.type === "agent")
      return `<div class="ahead"><span class="avatar" style="background:${this._wtColor(n.wt)}">${I.agent}</span>
        <div style="flex:1;min-width:0"><div class="lbl">${esc(n.title)}</div><div class="role">${esc(n.role || "")}</div></div>${pill}</div>
        <div class="think one">${esc(n.thought || "")}</div>
        <div class="wttag"><span class="sw" style="background:${this._wtColor(n.wt)}"></span>${this._wtName(n.wt)}${n.dur ? " · " + esc(n.dur) : ""}</div>`;
    if (n.type === "tool")
      return `<div class="row"><span class="kic">${KIC[n.kind] || I.read}</span><span class="lbl">${esc(n.title)}</span>${pill}</div>
        <div class="file" style="margin-top:4px">${esc(n.file || "")}</div>
        <div class="think one">${esc(n.thought || "")}</div>`;
    if (n.type === "synth")
      return `<div class="row"><span class="aw-ic">${I.synth}</span><span class="lbl">${esc(n.title)}</span>${pill}</div>
        <div class="think one">${esc(n.thought || "")}</div>`;
    if (n.type === "file")
      return `<div class="row"><span class="sw" style="width:8px;height:8px;border-radius:2px;background:${this._wtColor(n.wt)};display:inline-block;flex:none"></span><span class="lbl">${esc(n.title)}</span><span class="langbadge">${esc(n.lang || "")}</span></div>
        <div class="file" style="margin-top:4px">${esc(n.dir || ".")}</div>
        <div class="fmeta">${n.importedBy || 0} in · ${n.imports || 0} out</div>`;
    if (n.type === "result") {
      const full = String(n.summary || "");
      // full by default; very big answers start collapsed. A toggle is always
      // available once there's more than a few lines of output.
      const veryBig = full.length > 1500;
      const collapsed = n.collapsed == null ? veryBig : n.collapsed;
      const shown = collapsed ? full.slice(0, 420).replace(/\s+\S*$/, "") : full;
      const btn = full.length > 280 ? `<button class="outbtn">${collapsed ? "▾ expand full output" : "▴ collapse"}</button>` : "";
      return `<div class="rh"><span class="aw-ic" style="color:${n.donePill && n.donePill.k === "danger" ? "var(--color-text-danger)" : "var(--color-text-success)"}">${I.check}</span>
        <span class="lbl">${esc(n.title)}</span><span class="meta">${esc(n.meta || "")}</span></div>
        <div class="output">${mdToHtml(shown)}${collapsed ? "…" : ""}</div>${btn}`;
    }
    return "";
  }

  _path(a, b) {
    if (this.model && this.model.edgeStyle === "graph") return this._curve(a, b);
    const x1 = a.x + a.w / 2, y1 = a.y + a.h, x2 = b.x + b.w / 2, y2 = b.y, my = (y1 + y2) / 2;
    return `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`;
  }
  // center-to-center S-curve (dependency graph, not a top-down tree)
  _curve(a, b) {
    const ax = a.x + a.w / 2, ay = a.y + a.h / 2, bx = b.x + b.w / 2, by = b.y + b.h / 2;
    if (Math.abs(bx - ax) >= Math.abs(by - ay)) {
      const mx = (ax + bx) / 2;
      return `M${ax},${ay} C${mx},${ay} ${mx},${by} ${bx},${by}`;
    }
    const my = (ay + by) / 2;
    return `M${ax},${ay} C${ax},${my} ${bx},${my} ${bx},${by}`;
  }

  // ---- code cluster on the same board (auxiliary model) -----------------
  setAux(model) {
    for (const k in this.auxEls) { this.auxEls[k].remove(); delete this.auxEls[k]; }
    for (const k in this.auxEdgeEls) { this.auxEdgeEls[k].remove(); delete this.auxEdgeEls[k]; }
    this.aux = model || null;
    if (this.aux) {
      // park the code cluster to the right of the current conversation
      let maxX = 0;
      if (this.model && this.model.nodes.length) for (const n of this.model.nodes) maxX = Math.max(maxX, n.x + n.w);
      this.auxOrigin = { x: (maxX || 0) + 180, y: 0 };
    } else if (this.clusterLabelEl) { this.clusterLabelEl.remove(); this.clusterLabelEl = null; }
    this.sync();
  }
  _syncAux() {
    if (!this.aux) return;
    const live = new Set(this.aux.nodes.map((n) => "aux:" + n.id));
    for (const k in this.auxEls) if (!live.has(k)) { this.auxEls[k].remove(); delete this.auxEls[k]; }
    for (const n of this.aux.nodes) {
      const key = "aux:" + n.id;
      let el = this.auxEls[key];
      if (!el) {
        el = document.createElement("div");
        el.className = "cnode t-file";
        el.innerHTML = this._card(n);
        el.addEventListener("click", (e) => { e.stopPropagation(); this._selectAux(n); });
        this.world.appendChild(el);
        this.auxEls[key] = el;
      }
    }
    for (const e of this.aux.edges) {
      const key = "aux:" + e.from + ">" + e.to;
      if (!this.auxEdgeEls[key]) {
        const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
        p.setAttribute("class", "cedge cross");
        this.edgesSvg.appendChild(p);
        this.auxEdgeEls[key] = p;
      }
    }
  }
  _renderAux() {
    if (!this.aux) return;
    const ox = this.auxOrigin.x, oy = this.auxOrigin.y, abs = {};
    for (const n of this.aux.nodes) {
      const el = this.auxEls["aux:" + n.id]; if (!el) continue;
      const X = ox + n.x, Y = oy + n.y;
      abs[n.id] = { x: X, y: Y, w: n.w, h: n.h };
      el.style.cssText = `left:${X}px;top:${Y}px;width:${n.w}px`;
      el.classList.add("show");
      el.classList.toggle("touched", !!n.touched);
    }
    for (const e of this.aux.edges) {
      const p = this.auxEdgeEls["aux:" + e.from + ">" + e.to];
      const a = abs[e.from], b = abs[e.to];
      if (!p || !a || !b) continue;
      p.setAttribute("d", this._curve(a, b));
      p.classList.add("on");
    }
    if (!this.clusterLabelEl) { this.clusterLabelEl = document.createElement("div"); this.clusterLabelEl.className = "clusterlabel"; this.world.appendChild(this.clusterLabelEl); }
    this.clusterLabelEl.textContent = this.aux.headline || "code";
    this.clusterLabelEl.style.left = ox + "px";
    this.clusterLabelEl.style.top = (oy - 30) + "px";
  }
  _selectAux(n) {
    // lightweight inspector for a code file node
    this.selected = null;
    this.inspector.classList.add("open");
    this.inwrap.innerHTML = `<div class="crumb"><span class="sw" style="background:${this._wtColor(n.wt)}"></span>${esc(n.dir || ".")}</div>
      <div class="inh">${esc(n.title)}</div>
      <div class="pills"><span class="aw-pill" style="background:var(--color-background-secondary);color:var(--color-text-secondary)">${esc(n.lang || "file")}</span>
      <span class="aw-pill" style="background:var(--color-background-secondary);color:var(--color-text-secondary)">${n.importedBy || 0} in · ${n.imports || 0} out</span></div>
      <div class="blk"><h4>Path</h4><div class="code">${esc(n.path || n.id)}</div></div>`;
  }
  // focus (pan/zoom) the camera onto the code cluster, loading-aware
  focusAux() {
    if (!this.aux || !this.aux.nodes.length) return;
    const ns = this.aux.nodes;
    let a = 1e9, b = 1e9, c = -1e9, d = -1e9;
    for (const n of ns) { a = Math.min(a, n.x); b = Math.min(b, n.y); c = Math.max(c, n.x + n.w); d = Math.max(d, n.y + n.h); }
    a += this.auxOrigin.x; c += this.auxOrigin.x; b += this.auxOrigin.y; d += this.auxOrigin.y;
    const r = this.viewport.getBoundingClientRect(), pad = 64;
    if (r.width < 2) return;
    this.onUserCam && this.onUserCam();
    const s = Math.min(1, Math.max(0.25, Math.min((r.width - pad * 2) / (c - a), (r.height - pad * 2) / (d - b))));
    this.cam.s = s;
    this.cam.x = pad - a * s + (r.width - pad * 2 - (c - a) * s) / 2;
    this.cam.y = pad - b * s;
    this._easeCam(); this._applyCam();
  }

  // lane color/name resolved from the model registry, with a static fallback
  _wtColor(k) {
    const m = (this.model && this.model.wtMap && this.model.wtMap[k]) || (this.aux && this.aux.wtMap && this.aux.wtMap[k]);
    return (m && m.color) || (WT_FALLBACK[k] && WT_FALLBACK[k].color) || "var(--wt-main)";
  }
  _wtName(k) {
    const m = (this.model && this.model.wtMap && this.model.wtMap[k]) || (this.aux && this.aux.wtMap && this.aux.wtMap[k]);
    return (m && m.name) || (WT_FALLBACK[k] && WT_FALLBACK[k].name) || k || "main";
  }

  // ---- inspector --------------------------------------------------------
  select(id) {
    const n = this.model.byId[id]; if (!n) return;
    this.selected = id;
    const d = n.detail || {};
    this.inspector.classList.add("open");
    const sl = n.status === "run" ? "running" : n.status === "pend" ? "pending" : n.donePill ? n.donePill.l : "done";
    const sk = "p-" + (n.status === "run" ? "info" : n.status === "pend" ? "warning" : n.donePill ? n.donePill.k : "success");
    const head = n.type === "tool" ? `${n.title} · ${n.file || ""}` : n.title;
    const tag = (txt) => `<span class="aw-pill" style="background:var(--color-background-secondary);color:var(--color-text-secondary)">${esc(txt)}</span>`;

    let h = `<div class="crumb"><span class="sw" style="background:${this._wtColor(n.wt)}"></span>${this._wtName(n.wt)} <span>›</span> ${n.type}</div>
      <div class="inh">${esc(head)}</div>`;
    if (n.type === "say" && n.text) h += `<div class="blk"><h4>Message</h4><div class="reason">${esc(n.text)}</div></div>`;
    if (n.thought) h += `<div class="lead">“${esc(n.thought)}”</div>`;
    h += `<div class="pills"><span class="aw-pill ${sk}">${esc(sl)}</span>`;
    if (n.role) h += tag(n.role);
    if (n.model) h += tag(n.model);
    const tok = d.tokens || n.tokens; if (tok) h += tag(tok);
    if (d.dur) h += tag(d.dur);
    h += `</div>`;

    if (n.summary) h += `<div class="blk"><h4>Summary</h4><div class="reason">${esc(n.summary)}</div></div>`;
    if (d.think) h += `<div class="blk"><h4>What it's doing</h4><div class="reason">${esc(d.think)}</div></div>`;
    if (d.input) h += `<div class="blk"><h4>Tool input</h4><div class="code">${this._input(d.input)}</div></div>`;
    if (d.diff) h += `<div class="blk"><h4>Diff</h4><div class="code diff">${d.diff.map(([c, t]) => `<span class="${c}">${esc(t)}</span>`).join("")}</div></div>`;
    else if (d.out) h += `<div class="blk"><h4>Output</h4><div class="code">${esc(d.out)}</div></div>`;
    if (d.events && d.events.length) h += `<div class="blk"><h4>Activity</h4><ul class="events">${d.events.map(([t, l]) => `<li><span class="t">${esc(t)}</span>${esc(l)}</li>`).join("")}</ul></div>`;

    if (n.type !== "file") {
      h += `<div class="insteer"><h4>Follow up</h4>
        <textarea id="steertext" placeholder="ask a follow-up — continues this session"></textarea>
        <div class="acts"><button class="btn primary" id="steersend">send ↗</button></div></div>`;
    }
    this.inwrap.innerHTML = h;

    const send = this.inwrap.querySelector("#steersend");
    if (send) send.onclick = () => {
      const t = this.inwrap.querySelector("#steertext").value.trim();
      if (t && this.onSteer) this.onSteer(n, t);
    };
    if (this.target) this.target.innerHTML = `<span class="sw" style="background:${this._wtColor(n.wt)}"></span>${esc(n.title)}`;
    this.render();
  }
  deselect() {
    this.selected = null;
    this.inspector.classList.remove("open");
    if (this.target) this.target.innerHTML = `<span class="sw" style="background:var(--wt-main)"></span>session`;
    this.render();
  }
  _input(input) {
    return Object.entries(input).map(([k, v]) => {
      let val = typeof v === "string" ? v : JSON.stringify(v);
      if (val.length > 400) val = val.slice(0, 399) + "…";
      return `<span class="ik">${esc(k)}</span>: ${esc(val)}`;
    }).join("\n");
  }

  // ---- worktree filter --------------------------------------------------
  setWtFilter(wt) { this.selWt = this.selWt === wt ? null : wt; this.render(); return this.selWt; }

  // ---- camera -----------------------------------------------------------
  _wireCamera(els) {
    let dr = 0, sx, sy, cx0, cy0;
    this.viewport.addEventListener("mousedown", (e) => {
      dr = 1; this.viewport.classList.add("drag");
      this.world.style.transition = "none"; // instant while dragging
      this.onUserCam && this.onUserCam();
      sx = e.clientX; sy = e.clientY; cx0 = this.cam.x; cy0 = this.cam.y;
    });
    window.addEventListener("mousemove", (e) => {
      if (!dr) return;
      this.cam.x = cx0 + (e.clientX - sx); this.cam.y = cy0 + (e.clientY - sy); this._applyCam();
    });
    window.addEventListener("mouseup", () => { dr = 0; this.viewport.classList.remove("drag"); });
    this.viewport.addEventListener("click", () => this.deselect());
    this.viewport.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.world.style.transition = "none"; // instant zoom under the cursor
      this.onUserCam && this.onUserCam();
      const r = this.viewport.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
      const f = e.deltaY < 0 ? 1.1 : 1 / 1.1, ns = Math.min(2, Math.max(0.25, this.cam.s * f));
      this.cam.x = mx - (mx - this.cam.x) * (ns / this.cam.s);
      this.cam.y = my - (my - this.cam.y) * (ns / this.cam.s);
      this.cam.s = ns; this._applyCam();
    }, { passive: false });
  }
  // animate the next programmatic camera move (follow / fit / zoom buttons)
  _easeCam() { this.world.style.transition = "transform .32s cubic-bezier(.4,0,.2,1)"; }
  _applyCam() {
    this.world.style.transform = `translate(${this.cam.x}px,${this.cam.y}px) scale(${this.cam.s})`;
    if (this.zl) this.zl.textContent = Math.round(this.cam.s * 100) + "%";
    this._renderMinimap();
  }
  zoom(f) { this.onUserCam && this.onUserCam(); this.cam.s = Math.min(2, Math.max(0.25, this.cam.s * f)); this._easeCam(); this._applyCam(); }

  // double-click a node -> ease in and center it
  zoomToNode(id, select = true) {
    const n = this.model && this.model.byId[id]; if (!n) return;
    const r = this.viewport.getBoundingClientRect(); if (r.width < 2) return;
    this.onUserCam && this.onUserCam();
    const s = Math.min(1.7, Math.max(0.7, (r.width * 0.55) / n.w));
    this.cam.s = s;
    this.cam.x = r.width / 2 - (n.x + n.w / 2) * s;
    this.cam.y = r.height / 2 - (n.y + n.h / 2) * s;
    this._easeCam(); this._applyCam();
    if (select && n.type !== "lane") this.select(id);
  }
  // pan to a node at the current zoom (no scale change, no selection)
  panToNode(id) {
    const n = this.model && this.model.byId[id]; if (!n) return;
    const r = this.viewport.getBoundingClientRect(); if (r.width < 2) return;
    this.onUserCam && this.onUserCam();
    const s = this.cam.s;
    this.cam.x = r.width / 2 - (n.x + n.w / 2) * s;
    this.cam.y = r.height / 2 - (n.y + n.h / 2) * s;
    this._easeCam(); this._applyCam();
  }
  goLatest() { const m = this.model; if (m && m.nodes.length) this.panToNode(m.nodes[m.nodes.length - 1].id); }
  goFirst() { const m = this.model; if (m && m.nodes.length) this.panToNode(m.nodes[0].id); }

  // tidy the board: drop manual lane drags so lanes snap back to auto-layout
  arrange() {
    if (this.model) this.model.laneOffset = {};
    this.sync();
    this.fit();
    this.onPersist && this.onPersist();
  }

  // ---- board search (text match -> highlight + fly between matches) ------
  search(q) {
    q = String(q || "").trim().toLowerCase();
    const prev = this.searchHits.join(",");
    this.searchHits = [];
    if (q && this.model) {
      for (const n of this.model.nodes) {
        if (n.type === "lane") continue;
        const hay = [n.title, n.text, n.file, n.summary, n.thought, n.role, n.model].filter(Boolean).join(" ").toLowerCase();
        if (hay.includes(q)) this.searchHits.push(n.id);
      }
    }
    this._searchIdx = -1;
    if (this.searchHits.join(",") !== prev) this.sync(); else this.render();
    if (this.searchHits.length) this.nextHit(1);
    return this.searchHits.length;
  }
  nextHit(dir = 1) {
    if (!this.searchHits.length) return 0;
    this._searchIdx = (this._searchIdx + dir + this.searchHits.length) % this.searchHits.length;
    this.zoomToNode(this.searchHits[this._searchIdx]);
    return this.searchHits.length;   // caller shows `_searchIdx+1 / this`
  }
  clearSearch() { if (this.searchHits.length) { this.searchHits = []; this._searchIdx = -1; this.sync(); } }

  // instant, no-animation anchor for a brand-new conversation: pin the content's
  // top near the top of the viewport so the first node doesn't fly in and bounce
  home() {
    const m = this.model; if (!m || !m.nodes.length) return;
    const r = this.viewport.getBoundingClientRect(); if (r.width < 2) return;
    let minX = 1e9, minY = 1e9, maxX = -1e9;
    for (const n of m.nodes) { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x + n.w); }
    this.cam.s = 1;
    this.cam.x = r.width / 2 - ((minX + maxX) / 2) * this.cam.s;
    this.cam.y = 72 - minY * this.cam.s;
    this.world.style.transition = "none";
    this._applyCam();
  }
  fit() {
    const m = this.model; if (!m || !m.nodes.length) return;
    let a = 1e9, b = 1e9, c = -1e9, d = -1e9;
    for (const n of m.nodes) { a = Math.min(a, n.x); b = Math.min(b, n.y); c = Math.max(c, n.x + n.w); d = Math.max(d, n.y + n.h); }
    const r = this.viewport.getBoundingClientRect(), pad = 56;
    if (r.width < 2 || r.height < 2) return; // window hidden/zero-size — skip

    const sw = (r.width - pad * 2) / (c - a), sh = (r.height - pad * 2) / (d - b);
    this.cam.s = Math.min(1.05, Math.max(0.25, Math.min(sw, sh)));
    this.cam.x = pad - a * this.cam.s + (r.width - pad * 2 - (c - a) * this.cam.s) / 2;
    this.cam.y = pad - b * this.cam.s;
    this._easeCam();
    this._applyCam();
  }

  // pan (no zoom change) so the newest node stays in view — like a chat log.
  // While the whole conversation fits, its TOP is anchored (no drift); once it
  // overflows, the newest node is pinned near the bottom. It never recenters to
  // the middle, so the first node can't bounce top -> middle -> top.
  follow() {
    const m = this.model; if (!m || !m.nodes.length) return;
    const r = this.viewport.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const s = this.cam.s;
    const newest = m.nodes[m.nodes.length - 1];
    let minY = 1e9, maxY = -1e9;
    for (const n of m.nodes) { minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y + n.h); }
    const topPad = 72, botPad = 56;
    if ((maxY - minY) * s <= r.height - topPad - botPad) {
      this.cam.y = topPad - minY * s;                              // whole convo fits: anchor its top
    } else {
      this.cam.y = (r.height - botPad) - (newest.y + newest.h) * s; // overflow: pin newest near bottom
    }
    // x: only move if the newest node would be off-screen horizontally
    const nx = (newest.x + newest.w / 2) * s + this.cam.x;
    if (nx < 90 || nx > r.width - 90) this.cam.x = r.width / 2 - (newest.x + newest.w / 2) * s;
    this._easeCam();
    this._applyCam();
  }

  // drag an entire lane around the board via its header card
  _wireLane(el, n) {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      if (el._moved) { el._moved = false; return; }   // a drag, not a click
      this.onLaneSelect && this.onLaneSelect(n.lane);
    });
    el.addEventListener("mousedown", (e) => {
      if (e.target.closest(".lane-compact")) return;   // let the compact button click through
      e.stopPropagation();
      this.onUserCam && this.onUserCam();
      const m = this.model, lane = n.lane;
      m.laneOffset = m.laneOffset || {};
      const o = (m.laneOffset[lane] = m.laneOffset[lane] || { dx: 0, dy: 0 });
      const sx = e.clientX, sy = e.clientY, odx = o.dx, ody = o.dy, sc = this.cam.s;
      let moved = false;
      el.classList.add("dragging");
      const mv = (ev) => {
        if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
        moved = true; el._moved = true;
        o.dx = odx + (ev.clientX - sx) / sc; o.dy = ody + (ev.clientY - sy) / sc;
        layout(m); this.render();
      };
      const up = () => {
        window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up);
        el.classList.remove("dragging");
        if (moved) this.onPersist && this.onPersist();
      };
      window.addEventListener("mousemove", mv); window.addEventListener("mouseup", up);
    });
  }

  // ---- Miro board: sticky notes ----------------------------------------
  _renderNotes() {
    const live = new Set(this.notes.map((n) => n.id));
    for (const id in this.noteEls) if (!live.has(id)) { this.noteEls[id].remove(); delete this.noteEls[id]; }
    for (const note of this.notes) {
      let el = this.noteEls[note.id];
      if (!el) { el = this._makeNote(note); this.noteEls[note.id] = el; this.world.appendChild(el); }
      el.style.left = note.x + "px"; el.style.top = note.y + "px"; el.style.width = (note.w || 180) + "px";
      el.style.background = note.color || "#fef6c7";
      el.classList.toggle("pinned", !!note.pinned);
    }
  }
  _makeNote(note) {
    const el = document.createElement("div");
    el.className = "note";
    el.innerHTML = `<div class="notebar"><button class="np" title="pin">★</button><button class="nc" title="color">◑</button><button class="nx" title="delete">×</button></div><textarea class="nt" placeholder="note…">${esc(note.text || "")}</textarea>`;
    const ta = el.querySelector(".nt");
    ta.addEventListener("input", () => { note.text = ta.value; this.onPersist && this.onPersist(); });
    ta.addEventListener("mousedown", (e) => e.stopPropagation());
    el.querySelector(".nx").onclick = (e) => { e.stopPropagation(); this.notes = this.notes.filter((x) => x !== note); el.remove(); delete this.noteEls[note.id]; this.onPersist && this.onPersist(); };
    el.querySelector(".np").onclick = (e) => { e.stopPropagation(); note.pinned = !note.pinned; el.classList.toggle("pinned", note.pinned); this.onPersist && this.onPersist(); };
    const colors = ["#fef6c7", "#d7eafe", "#dcf5dd", "#fbe0e0", "#ece7fb"];
    el.querySelector(".nc").onclick = (e) => { e.stopPropagation(); note.color = colors[(colors.indexOf(note.color) + 1) % colors.length]; el.style.background = note.color; this.onPersist && this.onPersist(); };
    el.addEventListener("mousedown", (e) => {
      if (e.target.closest(".nt") || e.target.closest("button")) return;
      e.stopPropagation();
      const sx = e.clientX, sy = e.clientY, ox = note.x, oy = note.y, sc = this.cam.s;
      const mv = (ev) => { note.x = ox + (ev.clientX - sx) / sc; note.y = oy + (ev.clientY - sy) / sc; el.style.left = note.x + "px"; el.style.top = note.y + "px"; };
      const up = () => { window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); this.onPersist && this.onPersist(); };
      window.addEventListener("mousemove", mv); window.addEventListener("mouseup", up);
    });
    return el;
  }
  addNote(x, y) {
    const note = { id: "note" + Date.now().toString(36), x: x - 90, y: y - 36, w: 180, text: "", color: "#fef6c7", pinned: false };
    this.notes.push(note);
    this._renderNotes();
    this.onPersist && this.onPersist();
    const el = this.noteEls[note.id]; if (el) setTimeout(() => el.querySelector(".nt").focus(), 0);
  }

  // ---- right-click menu + minimap --------------------------------------
  _initBoard() {
    this.menu = document.createElement("div");
    this.menu.className = "ctxmenu";
    this.menu.style.display = "none";
    this.viewport.appendChild(this.menu);
    document.addEventListener("click", () => { this.menu.style.display = "none"; });
    this.viewport.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const r = this.viewport.getBoundingClientRect();
      const wx = (e.clientX - r.left - this.cam.x) / this.cam.s, wy = (e.clientY - r.top - this.cam.y) / this.cam.s;
      this._showMenu(e.clientX - r.left, e.clientY - r.top, wx, wy);
    });
    this.minimap = document.createElement("canvas");
    this.minimap.className = "minimap";
    this.minimap.width = 168; this.minimap.height = 112;
    this.viewport.appendChild(this.minimap);
    this.minimap.addEventListener("mousedown", (e) => this._minimapNav(e));
  }
  _showMenu(px, py, wx, wy) {
    const items = [
      ["＋  Add note", () => this.addNote(wx, wy)],
      ["⤳  New agent lane", () => this.onNewLane && this.onNewLane()],
      ["⊡  Fit to content", () => this.fit()],
    ];
    this.menu.innerHTML = "";
    for (const [label, fn] of items) {
      const it = document.createElement("div");
      it.className = "ctxitem"; it.textContent = label;
      it.onclick = (ev) => { ev.stopPropagation(); this.menu.style.display = "none"; fn(); };
      this.menu.appendChild(it);
    }
    this.menu.style.left = px + "px"; this.menu.style.top = py + "px"; this.menu.style.display = "block";
  }
  _bounds() {
    let a = 1e9, b = 1e9, c = -1e9, d = -1e9;
    const items = [...(this.model ? this.model.nodes : []), ...this.notes];
    for (const n of items) { a = Math.min(a, n.x); b = Math.min(b, n.y); c = Math.max(c, n.x + (n.w || 180)); d = Math.max(d, n.y + (n.h || 80)); }
    if (this.aux) for (const n of this.aux.nodes) { const X = this.auxOrigin.x + n.x, Y = this.auxOrigin.y + n.y; a = Math.min(a, X); b = Math.min(b, Y); c = Math.max(c, X + n.w); d = Math.max(d, Y + n.h); }
    if (!isFinite(a)) return null;
    return { a, b, c, d };
  }
  _renderMinimap() {
    const cv = this.minimap; if (!cv) return;
    const ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, cv.width, cv.height);
    const bb = this._bounds();
    const r = this.viewport.getBoundingClientRect();
    if (!bb || r.width < 2) { cv.style.display = "none"; return; }
    cv.style.display = "block";
    const pad = 8, bw = (bb.c - bb.a) || 1, bh = (bb.d - bb.b) || 1;
    const sc = Math.min((cv.width - pad * 2) / bw, (cv.height - pad * 2) / bh);
    const ox = pad - bb.a * sc, oy = pad - bb.b * sc;
    this._mm = { sc, ox, oy };
    ctx.fillStyle = "rgba(120,115,108,.5)";
    for (const n of (this.model ? this.model.nodes : [])) ctx.fillRect(n.x * sc + ox, n.y * sc + oy, Math.max(2, (n.w || 80) * sc), Math.max(2, (n.h || 40) * sc));
    if (this.aux) { ctx.fillStyle = "rgba(58,134,200,.5)"; for (const n of this.aux.nodes) ctx.fillRect((this.auxOrigin.x + n.x) * sc + ox, (this.auxOrigin.y + n.y) * sc + oy, Math.max(2, n.w * sc), Math.max(2, n.h * sc)); }
    ctx.fillStyle = "rgba(181,121,27,.6)";
    for (const n of this.notes) ctx.fillRect(n.x * sc + ox, n.y * sc + oy, Math.max(2, (n.w || 180) * sc), Math.max(2, 60 * sc));
    const vx = (-this.cam.x / this.cam.s) * sc + ox, vy = (-this.cam.y / this.cam.s) * sc + oy;
    ctx.strokeStyle = "rgba(28,95,199,.9)"; ctx.lineWidth = 1.2;
    ctx.strokeRect(vx, vy, (r.width / this.cam.s) * sc, (r.height / this.cam.s) * sc);
  }
  _minimapNav(e) {
    e.stopPropagation();
    if (!this._mm) return;
    const rect = this.minimap.getBoundingClientRect();
    const wx = (e.clientX - rect.left - this._mm.ox) / this._mm.sc, wy = (e.clientY - rect.top - this._mm.oy) / this._mm.sc;
    const r = this.viewport.getBoundingClientRect();
    this.cam.x = r.width / 2 - wx * this.cam.s; this.cam.y = r.height / 2 - wy * this.cam.s;
    this._easeCam(); this._applyCam();
  }
}

function clipSummary(s) {
  s = String(s || "");
  return s.length > 520 ? s.slice(0, 519) + "…" : s;
}
