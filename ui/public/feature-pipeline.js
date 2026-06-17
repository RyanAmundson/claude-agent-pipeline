// Feature (epic) graph view. Builds an SVG from the pure topology module, shows
// live per-state epic counts, and a drill-in of each building epic's children.
// Browser-only; pure logic lives in feature-pipeline-graph.js.
import {
  NODES, EDGES, VIEW, pathFor, pathEdgesForMove,
  seedEpicModel, applyEpicEvent, epicCountsOf, childProgress,
} from './feature-pipeline-graph.js';
import { colorForAgent } from './colors.js';

const SVGNS = 'http://www.w3.org/2000/svg';
let built = false, svg = null, statusEl = null, drillEl = null;
const nodeEls = new Map();
let model = { idState: new Map() };
let lastSnapshot = null;

function el(name, attrs = {}) {
  const e = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

function buildGraph() {
  svg = document.getElementById('feature-graph');
  statusEl = document.getElementById('feature-status');
  drillEl = document.getElementById('feature-epics');
  if (!svg) return false;
  svg.setAttribute('viewBox', `0 0 ${VIEW.w} ${VIEW.h}`);
  const edgeLayer = el('g', { class: 'pl-edges' });
  const nodeLayer = el('g', { class: 'pl-nodes' });
  for (const edge of EDGES) {
    edgeLayer.append(el('path', { class: `pl-edge kind-${edge.kind}`, d: pathFor(edge, NODES), 'data-edge': edge.id }));
  }
  for (const [id, n] of Object.entries(NODES)) {
    const g = el('g', { class: `pl-node kind-${n.kind} empty`, 'data-node': id, transform: `translate(${n.x},${n.y})` });
    g.append(el('rect', { class: 'pl-node-box', x: -52, y: -22, width: 104, height: 44, rx: 6 }));
    const label = el('text', { class: 'pl-node-label', y: n.agent ? -2 : 5 });
    label.textContent = n.label; g.append(label);
    if (n.agent) { const a = el('text', { class: 'pl-node-agent', y: 13 }); a.textContent = n.agent; g.append(a); }
    const countBg = el('circle', { class: 'pl-node-countbg', cx: 52, cy: -22, r: 9 });
    const countText = el('text', { class: 'pl-node-count', x: 52, y: -18.5 });
    g.append(countBg, countText);
    nodeEls.set(id, { g, countText });
    nodeLayer.append(g);
  }
  svg.append(edgeLayer, nodeLayer);
  return true;
}

function renderCounts() {
  const counts = epicCountsOf(model);
  for (const [id, n] of Object.entries(NODES)) {
    if (!n.state) continue;
    const els = nodeEls.get(id);
    const c = counts[n.state] || 0;
    els.countText.textContent = String(c);
    els.g.classList.toggle('empty', c === 0);
  }
}

// One row per building epic: title + a chip per child-state with counts.
function renderDrill() {
  if (!drillEl) return;
  drillEl.textContent = '';
  const building = lastSnapshot?.epics?.byState?.['building'] || [];
  const acceptance = lastSnapshot?.epics?.byState?.['needs-acceptance'] || [];
  for (const epic of [...building, ...acceptance]) {
    const p = childProgress(lastSnapshot, epic.id);
    const row = document.createElement('div');
    row.className = 'epic-row';
    const title = document.createElement('span');
    title.className = 'epic-title';
    title.textContent = `${epic.id} ${epic.title || ''}`;
    const prog = document.createElement('span');
    prog.className = 'epic-prog';
    prog.textContent = ` ${p.ready}/${p.total} ready`;
    row.append(title, prog);
    const chips = document.createElement('span');
    chips.className = 'epic-chips';
    for (const [state, n] of Object.entries(p.byState)) {
      const chip = document.createElement('span');
      chip.className = 'child-chip';
      chip.style.borderColor = colorForAgent(state);
      chip.textContent = `${state} ${n}`;
      chips.append(chip);
    }
    row.append(chips);
    drillEl.append(row);
  }
  if (statusEl) {
    const total = (lastSnapshot?.epics?.count) || 0;
    statusEl.textContent = `${total} epic${total === 1 ? '' : 's'}`;
  }
}

function applySnapshot(snap) {
  model = seedEpicModel(snap);
  lastSnapshot = snap;
  renderCounts();
  renderDrill();
}

function handleEvent(ev) {
  if (ev.type && ev.type.startsWith('epic.')) {
    model = applyEpicEvent(model, ev);
    renderCounts();
    return;
  }
  // ticket.* changes affect child progress; cheapest correct refresh is a refetch.
  if (ev.type && ev.type.startsWith('ticket.')) {
    fetch('/api/v1/snapshot').then(r => r.json()).then(s => { lastSnapshot = s; renderDrill(); }).catch(() => {});
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

export function initFeaturePipeline() {
  if (built) return;
  if (!buildGraph()) return;
  built = true;
  fetch('/api/v1/snapshot').then(r => r.json()).then(applySnapshot).catch(() => {
    if (statusEl) statusEl.textContent = 'failed to load features';
  });
  connect();
}
