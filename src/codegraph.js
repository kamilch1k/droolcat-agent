// codegraph.js — Milestone 3 Code Graph: the project as files + import edges.
//
// A CodeGraphModel is shaped like GraphModel (nodes/edges/byId/wtMap/stats) so
// the same Canvas renders it. Nodes are type "file"; layout clusters files into
// columns by top-level directory; edges are imports. Nodes an agent is touching
// are flagged via setTouched() for the cross-link with the Agent Graph.

const DIR_PALETTE = [
  "var(--wt-frontend)", "var(--wt-api)", "var(--wt-tests)",
  "#3a86c8", "#c1632b", "#b6478f", "#8a6116", "#615f59", "#2c7a39",
];

const base = (p) => String(p || "").replace(/\\/g, "/").split("/").filter(Boolean).pop() || p;

export class CodeGraphModel {
  constructor() { this.reset(); }
  reset() {
    this.nodes = []; this.edges = []; this.byId = {};
    this.wtMap = {}; this.headline = ""; this.edgeStyle = "graph";
  }

  load(graph) {
    this.reset();
    const g = graph || { nodes: [], edges: [] };
    const dirs = [...new Set(g.nodes.map((n) => n.dir))].sort();
    dirs.forEach((d, i) => { this.wtMap[d] = { name: d, color: DIR_PALETTE[i % DIR_PALETTE.length] }; });
    for (const n of g.nodes) {
      const node = {
        id: n.id, type: "file", path: n.path || n.id, dir: n.dir || ".",
        lang: n.lang || "", imports: n.imports || 0, importedBy: n.importedBy || 0,
        wt: n.dir || ".", title: base(n.id), status: "done", touched: false,
      };
      this.nodes.push(node);
      this.byId[n.id] = node;
    }
    for (const e of g.edges) if (this.byId[e.from] && this.byId[e.to]) this.edges.push({ from: e.from, to: e.to });
    this.truncated = !!g.truncated;
    this.headline = `${this.nodes.length} files · ${this.edges.length} imports` + (this.truncated ? " (truncated)" : "");
    this.layout();
  }

  // force-directed (Fruchterman–Reingold) layout so imports read as a real
  // dependency graph — connected files attract, everything else repels.
  layout() {
    const nodes = this.nodes, edges = this.edges, N = nodes.length;
    if (!N) return;
    nodes.forEach((n) => { n.w = 168; n.h = 52; });
    if (N === 1) { nodes[0].x = 40; nodes[0].y = 40; return; }
    // deterministic golden-spiral seed (no Math.random)
    nodes.forEach((n, i) => { const a = i * 2.399963, r = 26 * Math.sqrt(i + 1); n.x = Math.cos(a) * r; n.y = Math.sin(a) * r; });
    const idx = {}; nodes.forEach((n, i) => (idx[n.id] = i));
    const E = edges.map((e) => [idx[e.from], idx[e.to]]).filter((p) => p[0] != null && p[1] != null);
    const k = 210, k2 = k * k, iters = N > 140 ? 170 : 260, cool = 0.985;
    let temp = 320;
    for (let it = 0; it < iters; it++) {
      const dx = new Float64Array(N), dy = new Float64Array(N);
      for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {       // repulsion k²/d
        let vx = nodes[i].x - nodes[j].x, vy = nodes[i].y - nodes[j].y;
        let dist = Math.hypot(vx, vy) || 0.01;
        const f = k2 / dist, ux = vx / dist, uy = vy / dist;
        dx[i] += ux * f; dy[i] += uy * f; dx[j] -= ux * f; dy[j] -= uy * f;
      }
      for (const [a, b] of E) {                                          // attraction d²/k along imports
        let vx = nodes[a].x - nodes[b].x, vy = nodes[a].y - nodes[b].y;
        let dist = Math.hypot(vx, vy) || 0.01;
        const f = (dist * dist) / k, ux = vx / dist, uy = vy / dist;
        dx[a] -= ux * f; dy[a] -= uy * f; dx[b] += ux * f; dy[b] += uy * f;
      }
      for (let i = 0; i < N; i++) {                                      // integrate (temp-capped) + gentle centering
        const d = Math.hypot(dx[i], dy[i]) || 0.01, cap = Math.min(d, temp);
        nodes[i].x += (dx[i] / d) * cap - nodes[i].x * 0.003;
        nodes[i].y += (dy[i] / d) * cap - nodes[i].y * 0.003;
      }
      temp *= cool;
    }
    let minX = 1e9, minY = 1e9;
    for (const n of nodes) { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); }
    for (const n of nodes) { n.x = n.x - minX + 40; n.y = n.y - minY + 40; }
  }

  // cross-link: flag files whose path matches anything the agents touched
  setTouched(paths) {
    const list = [...(paths || [])];
    for (const n of this.nodes) {
      n.touched = list.some((p) => {
        if (!p) return false;
        // full-path suffix match only — NO bare-basename match (that would light
        // up every same-named file across unrelated directories)
        const a = n.id.toLowerCase(), b = String(p).replace(/\\/g, "/").toLowerCase();
        return a === b || a.endsWith("/" + b) || b.endsWith("/" + a);
      });
    }
  }

  stats() { return { running: 0, agents: 0, done: true, nodes: this.nodes.length }; }
}
