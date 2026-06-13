// Pipeline graph view. Builds an SVG from the pure topology module, shows live
// per-node counts and running-agent pulses, and (Task 7) animates ticket tokens.
// Browser-only; the pure logic lives in pipeline-graph.js.

import {
  NODES, EDGES, VIEW, pathFor,
  seedModel, applyEvent, countsOf, hasTicket, pathEdgesForMove,
} from './pipeline-graph.js';

const SVGNS = 'http://www.w3.org/2000/svg';

let built = false;
let svg = null;
let statusEl = null;
const edgeEls = new Map();   // edge id → <path>
const nodeEls = new Map();   // node id → { g, countText, countBg }
let model = { idState: new Map() };

function el(name, attrs = {}) {
  const e = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

function buildGraph() {
  svg = document.getElementById('pipeline-graph');
  statusEl = document.getElementById('pipeline-status');
  if (!svg) return false;
  svg.setAttribute('viewBox', `0 0 ${VIEW.w} ${VIEW.h}`);

  const edgeLayer = el('g', { class: 'pl-edges' });
  const tokenLayer = el('g', { class: 'pl-tokens', id: 'pl-tokens' });
  const nodeLayer = el('g', { class: 'pl-nodes' });

  for (const edge of EDGES) {
    const p = el('path', { class: `pl-edge kind-${edge.kind}`, d: pathFor(edge), 'data-edge': edge.id });
    edgeEls.set(edge.id, p);
    edgeLayer.append(p);
  }

  for (const [id, n] of Object.entries(NODES)) {
    const g = el('g', { class: `pl-node kind-${n.kind} empty`, 'data-node': id, transform: `translate(${n.x},${n.y})` });
    g.append(el('rect', { class: 'pl-node-box', x: -52, y: -22, width: 104, height: 44, rx: 6 }));
    const label = el('text', { class: 'pl-node-label', y: n.agent ? -2 : 5 });
    label.textContent = n.label;
    g.append(label);
    if (n.agent) {
      const ag = el('text', { class: 'pl-node-agent', y: 13 });
      ag.textContent = n.agent;
      g.append(ag);
    }
    const countBg = el('circle', { class: 'pl-node-countbg', cx: 52, cy: -22, r: 9 });
    const countText = el('text', { class: 'pl-node-count', x: 52, y: -18.5 });
    g.append(countBg, countText);
    nodeEls.set(id, { g, countText, countBg });
    nodeLayer.append(g);

    const title = el('title');
    title.textContent = n.agent ? `${n.label} — ${n.agent}` : n.label;
    g.append(title);
  }

  svg.append(edgeLayer, tokenLayer, nodeLayer);
  return true;
}

function renderCounts() {
  const counts = countsOf(model);
  for (const [id, n] of Object.entries(NODES)) {
    if (!n.state) continue;
    const els = nodeEls.get(id);
    const c = counts[n.state] || 0;
    els.countText.textContent = String(c);
    els.g.classList.toggle('empty', c === 0);
  }
}

function renderRunning(snapshot) {
  const runningAgents = new Set(
    (snapshot.agents || [])
      .filter(a => (a.activity?.runs || []).length)
      .map(a => a.name),
  );
  for (const [id, n] of Object.entries(NODES)) {
    nodeEls.get(id).g.classList.toggle('running', !!n.agent && runningAgents.has(n.agent));
  }
}

function applySnapshot(snapshot) {
  model = seedModel(snapshot);
  renderCounts();
  renderRunning(snapshot);
  if (statusEl) {
    const total = Object.values(countsOf(model)).reduce((a, b) => a + b, 0);
    statusEl.textContent = `${total} ticket${total === 1 ? '' : 's'} in flight`;
  }
}

let es = null;
function connect() {
  if (es) es.close();
  es = new EventSource('/api/v1/events');
  es.onmessage = ev => {
    let data; try { data = JSON.parse(ev.data); } catch { return; }
    if (data.type === 'snapshot') return applySnapshot(data.data);
    handleEvent(data);
  };
  es.onerror = () => { es.close(); es = null; setTimeout(connect, 3000); };
}

// Task 7 replaces this with token animation; for now just keep counts current.
function handleEvent(ev) {
  if (ev.type === 'ticket.move' || ev.type === 'ticket.upsert' || ev.type === 'ticket.remove') {
    model = applyEvent(model, ev);
    renderCounts();
  }
}

export function initPipeline() {
  if (built) return;
  if (!buildGraph()) return;
  built = true;
  fetch('/api/v1/snapshot').then(r => r.json()).then(applySnapshot).catch(() => {
    if (statusEl) { statusEl.textContent = 'failed to load pipeline'; statusEl.className = 'agents-empty'; }
  });
  connect();
}
