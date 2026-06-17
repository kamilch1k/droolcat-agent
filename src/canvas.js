// canvas.js — renders the GraphModel as a pan/zoom spatial tree.
// Pure presentation: it reads nodes/edges (already laid out by graph.js),
// reconciles DOM, animates status, and owns the camera + inspector.

import { I, KIC } from "./icons.js";

const WT_FALLBACK = {
  main: { name: "main", color: "var(--wt-main)" },
  frontend: { name: "wt/frontend", color: "var(--wt-frontend)" },
  api: { name: "wt/api", color: "var(--wt-api)" },
  tests: { name: "wt/tests", color: "var(--wt-tests)" },
};
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

export class Canvas {
  constructor(els, { onSteer, onMerge, onOpenWorktree } = {}) {
    this.world = els.world;
    this.edgesSvg = els.edges;
    this.viewport = els.viewport;
    this.inspector = els.inspector;
    this.inwrap = els.inwrap;
    this.headpill = els.headpill;
    this.target = els.target;
    this.empty = els.empty;
    this.zl = els.zl;
    this.onSteer = onSteer;
    this.onMerge = onMerge;
    this.onOpenWorktree = onOpenWorktree;

    this.model = null;
    this.els = {};        // node id -> DOM el
    this.edgeEls = {};     // edge key -> path
    this.cam = { x: 120, y: 60, s: 1 };
    this.selected = null;
    this.selWt = null;

    this._wireCamera(els);
  }

  setModel(m) { this.model = m; }

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

    for (const n of m.nodes) {
      let el = this.els[n.id];
      if (!el) {
        el = document.createElement("div");
        el.addEventListener("click", (e) => { e.stopPropagation(); this.select(n.id); });
        this.world.appendChild(el);
        this.els[n.id] = el;
      }
      // base class is set once; render() owns the state classes (show/running/sel/dim)
      const base = "cnode t-" + n.type + (n.kind ? " k-" + n.kind : "");
      if (el._base !== base) { el.className = base; el._base = base; }
      const sig = `${n.type}|${n.kind || ""}|${n.status}|${n.title}|${n.file || ""}|${n.text || ""}|${n.thought || ""}|${n.donePill ? n.donePill.l : ""}|${n.summary ? n.summary.length : 0}|${n.meta || ""}|${n.model || ""}`;
      if (el._sig !== sig) { el.innerHTML = this._card(n); el._sig = sig; }
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

    if (this.empty) this.empty.classList.toggle("hide", m.nodes.length > 0);
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
      this._pill(el, n);
      maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + n.h);
    }
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
    if (n.type === "prompt")
      return `<div class="row"><span class="aw-ic">${I.user}</span><span class="lbl">You</span><span class="meta" style="margin-left:auto">turn ${n.turn || 1}</span></div>
        <div class="prompttext">${esc(n.text || "")}</div>`;
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
    if (n.type === "result")
      return `<div class="rh"><span class="aw-ic" style="color:${n.donePill && n.donePill.k === "danger" ? "var(--color-text-danger)" : "var(--color-text-success)"}">${I.check}</span>
        <span class="lbl">${esc(n.title)}</span><span class="meta">${esc(n.meta || "")}</span></div>
        <div class="summary">${esc(clipSummary(n.summary))}</div>`;
    return "";
  }

  _path(a, b) {
    if (this.model && this.model.edgeStyle === "graph") {
      // center-to-center S-curve (dependency graph, not a top-down tree)
      const ax = a.x + a.w / 2, ay = a.y + a.h / 2, bx = b.x + b.w / 2, by = b.y + b.h / 2;
      if (Math.abs(bx - ax) >= Math.abs(by - ay)) {
        const mx = (ax + bx) / 2;
        return `M${ax},${ay} C${mx},${ay} ${mx},${by} ${bx},${by}`;
      }
      const my = (ay + by) / 2;
      return `M${ax},${ay} C${ax},${my} ${bx},${my} ${bx},${by}`;
    }
    const x1 = a.x + a.w / 2, y1 = a.y + a.h, x2 = b.x + b.w / 2, y2 = b.y, my = (y1 + y2) / 2;
    return `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`;
  }

  // lane color/name resolved from the model registry, with a static fallback
  _wtColor(k) {
    const m = this.model && this.model.wtMap && this.model.wtMap[k];
    return (m && m.color) || (WT_FALLBACK[k] && WT_FALLBACK[k].color) || "var(--wt-main)";
  }
  _wtName(k) {
    const m = this.model && this.model.wtMap && this.model.wtMap[k];
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
    this.target.innerHTML = `<span class="sw" style="background:${this._wtColor(n.wt)}"></span>${esc(n.title)}`;
    this.render();
  }
  deselect() {
    this.selected = null;
    this.inspector.classList.remove("open");
    this.target.innerHTML = `<span class="sw" style="background:var(--wt-main)"></span>session`;
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
      const r = this.viewport.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
      const f = e.deltaY < 0 ? 1.1 : 1 / 1.1, ns = Math.min(2, Math.max(0.25, this.cam.s * f));
      this.cam.x = mx - (mx - this.cam.x) * (ns / this.cam.s);
      this.cam.y = my - (my - this.cam.y) * (ns / this.cam.s);
      this.cam.s = ns; this._applyCam();
    }, { passive: false });
  }
  _applyCam() {
    this.world.style.transform = `translate(${this.cam.x}px,${this.cam.y}px) scale(${this.cam.s})`;
    if (this.zl) this.zl.textContent = Math.round(this.cam.s * 100) + "%";
  }
  zoom(f) { this.cam.s = Math.min(2, Math.max(0.25, this.cam.s * f)); this._applyCam(); }
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
    this._applyCam();
  }

  // pan (no zoom change) so the newest node stays in view — like a chat
  // scrolling down as it works, instead of a jumpy refit on every event
  follow() {
    const m = this.model; if (!m || !m.nodes.length) return;
    const r = this.viewport.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const n = m.nodes[m.nodes.length - 1];
    const s = this.cam.s;
    this.cam.x = r.width / 2 - (n.x + n.w / 2) * s;
    this.cam.y = r.height * 0.6 - (n.y + n.h / 2) * s;
    this._applyCam();
  }
}

function clipSummary(s) {
  s = String(s || "");
  return s.length > 520 ? s.slice(0, 519) + "…" : s;
}
