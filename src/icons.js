// SVG icon set, carried over from the prototype. Stroked, 16x16 viewBox.
const SVG = (p, st) =>
  `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="${st || "currentColor"}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;

export const I = {
  user: SVG('<circle cx="8" cy="5.3" r="2.5"/><path d="M3.6 13c0-2.4 2-3.8 4.4-3.8S12.4 10.6 12.4 13"/>'),
  orch: SVG('<path d="M8 2l1.3 3.4L13 6.7 9.6 8 8 11.5 6.4 8 3 6.7l3.6-1.3z"/>'),
  agent: SVG('<rect x="3.4" y="5.4" width="9.2" height="7" rx="2"/><path d="M8 5.4V3.6"/><circle cx="8" cy="3" r=".8" fill="#fff" stroke="none"/><circle cx="6.1" cy="9" r=".95" fill="#fff" stroke="none"/><circle cx="9.9" cy="9" r=".95" fill="#fff" stroke="none"/>', "#fff"),
  read: SVG('<circle cx="6.8" cy="6.8" r="3.6"/><path d="M9.6 9.6L13.5 13.5"/>'),
  edit: SVG('<path d="M11.4 3.2l1.6 1.6-7.2 7.2-2.2.6.6-2.2z"/>'),
  write: SVG('<path d="M11.4 3.2l1.6 1.6-7.2 7.2-2.2.6.6-2.2z"/><path d="M9.8 4.8l1.6 1.6"/>'),
  bash: SVG('<rect x="2.4" y="3.4" width="11.2" height="9.2" rx="1.6"/><path d="M5 7l2 1.6L5 10.2"/><path d="M8.4 10.6h3"/>'),
  search: SVG('<circle cx="7" cy="7" r="4"/><path d="M10 10l3 3"/>'),
  web: SVG('<circle cx="8" cy="8" r="5.4"/><path d="M2.6 8h10.8M8 2.6c1.6 1.6 1.6 9.2 0 10.8M8 2.6C6.4 4.2 6.4 11.8 8 13.4"/>'),
  synth: SVG('<path d="M4 3.5v2.8a3.5 3.5 0 0 0 3.5 3.5H12"/><path d="M10 7.3l2 2.2-2 2.2"/>'),
  // MCP tool call — a connector plug with a cord
  mcp: SVG('<path d="M6 2.6v2.6M10 2.6v2.6"/><rect x="4.4" y="5.2" width="7.2" height="3.8" rx="1.3"/><path d="M8 9v2.4a2 2 0 0 0 2 2h1.6"/>'),
  // generic / unknown tool call — a target dot
  call: SVG('<circle cx="8" cy="8" r="4.8"/><circle cx="8" cy="8" r="1.3" fill="currentColor" stroke="none"/>'),
  check: SVG('<circle cx="8" cy="8" r="5.4"/><path d="M5.6 8.2l1.7 1.7 3.2-3.6"/>'),
  branch: SVG('<circle cx="5" cy="4" r="1.5"/><circle cx="5" cy="12" r="1.5"/><circle cx="11" cy="6" r="1.5"/><path d="M5 5.5v5M5 9.2c0-2.2 1.4-3 5.8-3.2"/>'),
  msg: SVG('<path d="M2.8 4.4h10.4v6.2H7l-3 2.4v-2.4H2.8z"/>'),
  plus: SVG('<path d="M8 3v10M3 8h10"/>'),
  mic: SVG('<rect x="6" y="2.4" width="4" height="7" rx="2"/><path d="M4 8a4 4 0 0 0 8 0M8 12v1.6M6 13.6h4"/>'),
  compact: SVG('<path d="M4 6.2l4 3 4-3M4 10.2l4 3 4-3"/>'),
  copy: SVG('<rect x="5.4" y="5.4" width="7.2" height="7.2" rx="1.4"/><path d="M10.6 5.4V4a1.4 1.4 0 0 0-1.4-1.4H4.4A1.4 1.4 0 0 0 3 4v4.8a1.4 1.4 0 0 0 1.4 1.4h1"/>'),
  up: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 12.5V4M4.5 7.5L8 4l3.5 3.5"/></svg>`,
  play: SVG('<path d="M5 3.5l7 4.5-7 4.5z" fill="currentColor" stroke="none"/>'),
  follow: SVG('<circle cx="8" cy="8" r="2.3"/><path d="M8 1.4v2.2M8 12.4v2.2M1.4 8h2.2M12.4 8h2.2"/>'),
  // big empty-state glyph
  graph: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="4" r="2"/><circle cx="5" cy="14" r="2"/><circle cx="12" cy="14" r="2"/><circle cx="19" cy="14" r="2"/><circle cx="5" cy="21" r="1.6"/><circle cx="19" cy="21" r="1.6"/><path d="M12 6v2M11 13l-5-7M13 13l5-7M5 16v3M19 16v3"/></svg>`,
};

// tool-kind -> icon, used on tool nodes
export const KIC = {
  read: I.read, edit: I.edit, write: I.write, bash: I.bash,
  search: I.search, web: I.web, synth: I.synth, mcp: I.mcp, call: I.call,
};
