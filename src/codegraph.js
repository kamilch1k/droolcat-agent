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

  layout() {
    const W = 178, H = 60, COLW = 212, ROWH = 76, PADX = 40, PADY = 24;
    const byDir = {};
    for (const n of this.nodes) (byDir[n.dir] = byDir[n.dir] || []).push(n);
    // widest clusters first, then alphabetical
    const dirNames = Object.keys(byDir).sort((a, b) => byDir[b].length - byDir[a].length || a.localeCompare(b));
    let x = PADX;
    for (const d of dirNames) {
      const list = byDir[d].sort((a, b) => b.importedBy - a.importedBy || a.title.localeCompare(b.title));
      let y = PADY;
      for (const n of list) { n.w = W; n.h = H; n.x = x; n.y = y; y += ROWH; }
      x += COLW;
    }
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
