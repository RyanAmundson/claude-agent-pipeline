// Minimal static SVG renderer shared by the self-improvement band and the
// features tab. Draws edges + nodes from a pure topology into a target <svg>
// (or sub-<g>), with optional per-state count badges. No animation, no live
// model — controllers re-call renderStaticCounts() on each snapshot.

import { pathFor } from './pipeline-graph.js';

const SVGNS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}) {
  const e = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

/**
 * Append an edge layer + node layer for `nodes`/`edges` to `svg`. Returns maps
 * of the created elements so a controller can update counts later.
 * @param {SVGElement} svg
 * @param {{nodes:object, edges:object[], counts?:object}} opts
 */
export function buildStaticGraph(svg, { nodes, edges, counts = {} }) {
  const edgeEls = new Map();
  const nodeEls = new Map();
  // Distinct group classes (not the spine's `pl-edges`/`pl-nodes`) so a
  // `querySelector('.pl-edges')` elsewhere can't ambiguously match this band's
  // layers. Per-element `.pl-edge`/`.pl-node` classes are unchanged, so styling
  // still applies.
  const edgeLayer = el('g', { class: 'pl-static-edges' });
  const nodeLayer = el('g', { class: 'pl-static-nodes' });

  for (const edge of edges) {
    const p = el('path', { class: `pl-edge kind-${edge.kind}`, d: pathFor(edge, nodes), 'data-edge': edge.id });
    edgeEls.set(edge.id, p);
    edgeLayer.append(p);
  }
  for (const [id, n] of Object.entries(nodes)) {
    const g = el('g', { class: `pl-node kind-${n.kind} empty`, 'data-node': id, transform: `translate(${n.x},${n.y})` });
    const title = el('title');
    title.textContent = n.agent ? `${n.label} — ${n.agent}` : n.label;
    g.append(title);
    g.append(el('rect', { class: 'pl-node-box', x: -52, y: -22, width: 104, height: 44, rx: 6 }));
    const label = el('text', { class: 'pl-node-label', y: n.agent ? -2 : 5 });
    label.textContent = n.label;
    g.append(label);
    if (n.agent) {
      const ag = el('text', { class: 'pl-node-agent', y: 13 });
      ag.textContent = n.agent;
      g.append(ag);
    }
    let countText = null;
    if (n.state) {
      g.append(el('circle', { class: 'pl-node-countbg', cx: 52, cy: -22, r: 9 }));
      countText = el('text', { class: 'pl-node-count', x: 52, y: -18.5 });
      g.append(countText);
    }
    nodeEls.set(id, { g, countText });
    nodeLayer.append(g);
  }
  svg.append(edgeLayer, nodeLayer);
  renderStaticCounts(nodeEls, nodes, counts);
  return { nodeEls, edgeEls };
}

/**
 * Append the agents band: compact chips for off-spine agents stacked in columns
 * under the spine stage each one works at, plus one faint stem per column from
 * the stage node down behind the stack. `spineNodes` supplies the stage-node
 * coordinates so the cross-graph feed paths can be drawn.
 * @param {SVGElement} svg
 * @param {{chips:object, feeds:object[], spineNodes:object}} opts
 */
export function buildAgentsBand(svg, { chips, feeds, spineNodes }) {
  const coords = { ...spineNodes, ...chips };
  const edgeLayer = el('g', { class: 'pl-band-edges' });
  const nodeLayer = el('g', { class: 'pl-band-nodes' });

  for (const f of feeds) {
    if (!coords[f.from] || !coords[f.to]) continue;
    edgeLayer.append(el('path', {
      class: 'pl-edge kind-bandfeed',
      d: pathFor({ from: f.from, to: f.to, bend: f.bend || 0 }, coords),
      'data-edge': f.id,
    }));
  }

  for (const [id, n] of Object.entries(chips)) {
    const w = n.w || 104;
    const h = n.h || 16;
    const g = el('g', { class: 'pl-node kind-agent', 'data-node': id, transform: `translate(${n.x},${n.y})` });
    const title = el('title');
    title.textContent = n.agent;
    g.append(title);
    g.append(el('rect', { class: 'pl-node-box', x: -w / 2, y: -h / 2, width: w, height: h, rx: 4 }));
    const label = el('text', { class: 'pl-node-label', y: 3 });
    label.textContent = n.label;
    g.append(label);
    nodeLayer.append(g);
  }

  svg.append(edgeLayer, nodeLayer);
  return { nodeLayer, edgeLayer };
}

/** Update count badges + the `empty` class for state-bearing nodes. */
export function renderStaticCounts(nodeEls, nodes, counts = {}) {
  for (const [id, n] of Object.entries(nodes)) {
    if (!n.state) continue;
    const els = nodeEls.get(id);
    if (!els || !els.countText) continue;
    const c = counts[n.state] || 0;
    els.countText.textContent = String(c);
    els.g.classList.toggle('empty', c === 0);
  }
}
