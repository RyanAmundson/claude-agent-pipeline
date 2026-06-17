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
  const edgeLayer = el('g', { class: 'pl-edges' });
  const nodeLayer = el('g', { class: 'pl-nodes' });

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
