// Pipeline graph view. Builds an SVG from the pure topology module, shows live
// per-node counts and running-agent pulses, and (Task 7) animates ticket tokens.
// Browser-only; the pure logic lives in pipeline-graph.js.

import {
  NODES, EDGES, VIEW, pathFor,
  seedModel, applyEvent, countsOf, hasTicket, pathEdgesForMove,
  countsFromCycle, runningAgentsFromCycle, countSourceForCycle,
} from './pipeline-graph.js';
import { colorForAgent } from './colors.js';

const SVGNS = 'http://www.w3.org/2000/svg';

const EDGE_MS = 750;                       // time a token spends per edge
const TOKEN_R = 5;                         // token circle radius (px)
const EDGE_FLASH_MS = 220;                 // edge flash highlight duration
const NODE_FLASH_MS = 260;                 // node flash highlight duration
const REDUCED = typeof matchMedia === 'function'
  && matchMedia('(prefers-reduced-motion: reduce)').matches;

const tokens = [];
let raf = null;
let lastTs = 0;

let built = false;
let svg = null;
let statusEl = null;
const edgeEls = new Map();   // edge id → <path>
const nodeEls = new Map();   // node id → { g, countText, countBg }
let model = { idState: new Map() };
// Latest orchestrator cycle + snapshot. On filesystem backends counts come from
// `model` (ticket.* events); on Linear/GitHub there is no queue, so counts and
// running agents come from the cycle report. Cycles are append-only — keep the
// last one across a later null/empty snapshot (a refetch race).
let latestCycle = null;
let lastSnapshot = null;

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
    // <title> first so assistive tech and tooltips pick it up as the node's name.
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
    const countBg = el('circle', { class: 'pl-node-countbg', cx: 52, cy: -22, r: 9 });
    const countText = el('text', { class: 'pl-node-count', x: 52, y: -18.5 });
    g.append(countBg, countText);
    nodeEls.set(id, { g, countText, countBg });
    nodeLayer.append(g);
  }

  svg.append(edgeLayer, tokenLayer, nodeLayer);
  return true;
}

// Per-state counts from whichever source the current backend trusts.
function currentCounts() {
  return countSourceForCycle(latestCycle) === 'cycle'
    ? countsFromCycle(latestCycle)
    : countsOf(model);
}

// Agents to pulse: filesystem run records (from the snapshot) ∪ the cycle
// report's running list (the only running signal on Linear/GitHub, and a
// supplement for in-session Task subagents on filesystem).
function runningAgentSet() {
  const set = new Set();
  for (const a of lastSnapshot?.agents || []) {
    if ((a.activity?.runs || []).length) set.add(a.name);
  }
  for (const name of runningAgentsFromCycle(latestCycle)) set.add(name);
  return set;
}

function renderCounts() {
  const counts = currentCounts();
  for (const [id, n] of Object.entries(NODES)) {
    if (!n.state) continue;
    const els = nodeEls.get(id);
    const c = counts[n.state] || 0;
    els.countText.textContent = String(c);
    els.g.classList.toggle('empty', c === 0);
  }
}

function renderRunning() {
  const running = runningAgentSet();
  for (const [id, n] of Object.entries(NODES)) {
    nodeEls.get(id).g.classList.toggle('running', !!n.agent && running.has(n.agent));
  }
}

function updateStatus() {
  if (!statusEl) return;
  const total = Object.values(currentCounts()).reduce((a, b) => a + b, 0);
  const via = countSourceForCycle(latestCycle) === 'cycle' ? ` · ${latestCycle.backend}` : '';
  statusEl.textContent = `${total} ticket${total === 1 ? '' : 's'} in flight${via}`;
}

// Briefly highlight every state node whose count changed between two snapshots
// of counts (used when a cycle report shifts Linear/GitHub counts wholesale).
function flashChangedNodes(prev, cur) {
  for (const n of Object.values(NODES)) {
    if (!n.state) continue;
    if ((prev[n.state] || 0) !== (cur[n.state] || 0)) flashNode(n.state);
  }
}

function applySnapshot(snapshot) {
  model = seedModel(snapshot);
  lastSnapshot = snapshot;
  if (snapshot.cycle) latestCycle = snapshot.cycle;  // append-only; never clear
  renderCounts();
  renderRunning();
  updateStatus();
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

function tick(ts) {
  const dt = lastTs ? ts - lastTs : 16;
  lastTs = ts;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const tk = tokens[i];
    tk.t += dt / EDGE_MS;
    const clamped = Math.min(tk.t, 1);
    const pt = tk.pathEl.getPointAtLength(clamped * tk.len);
    tk.el.setAttribute('cx', pt.x);
    tk.el.setAttribute('cy', pt.y);
    if (tk.t >= 1) {
      tk.el.remove();
      tokens.splice(i, 1);
      tk.onDone && tk.onDone();
    }
  }
  raf = tokens.length ? requestAnimationFrame(tick) : ((lastTs = 0), null);
}

function spawnToken(edgeId, color, onDone) {
  const pathEl = edgeEls.get(edgeId);
  if (!pathEl) { onDone && onDone(); return; }
  const len = pathEl.getTotalLength();
  const dot = el('circle', { class: 'pl-token', r: TOKEN_R, cx: 0, cy: 0 });
  if (color) dot.style.fill = color;
  document.getElementById('pl-tokens').append(dot);
  tokens.push({ el: dot, pathEl, len, t: 0, onDone });
  if (!raf) raf = requestAnimationFrame(tick);
}

// Animate an ordered list of edges as one continuous token (chains hops).
// onComplete fires after the last edge's token finishes.
function animatePath(edgeIds, color, onComplete) {
  if (!edgeIds.length) return;
  const run = i => {
    if (i < edgeIds.length) {
      const isLast = i === edgeIds.length - 1;
      spawnToken(edgeIds[i], color, () => {
        if (isLast && onComplete) onComplete();
        else run(i + 1);
      });
    }
  };
  run(0);
}

function flashEdge(edgeId) {
  const p = edgeEls.get(edgeId);
  if (!p) return;
  p.classList.add('flash');
  setTimeout(() => p.classList.remove('flash'), EDGE_FLASH_MS);
}

function flashNode(id) {
  const els = nodeEls.get(id);
  if (!els) return;
  els.g.classList.add('flash');
  setTimeout(() => els.g.classList.remove('flash'), NODE_FLASH_MS);
}

function colorForTicket(ticket) {
  return colorForAgent(ticket?.source?.agent);
}

function handleEvent(ev) {
  if (ev.type === 'cycle.report') {
    // The only live count/running signal on Linear/GitHub (no queue to watch).
    const before = currentCounts();
    latestCycle = ev.cycle;
    renderCounts();
    renderRunning();
    updateStatus();
    if (countSourceForCycle(latestCycle) === 'cycle') flashChangedNodes(before, currentCounts());
    return;
  }
  if (ev.type === 'ticket.move') {
    const edges = pathEdgesForMove(ev.from, ev.to);
    const color = colorForTicket(ev.ticket);
    if (REDUCED || !edges.length) {
      flashNode(ev.to);
    } else {
      animatePath(edges, color, () => flashEdge(edges[edges.length - 1]));
    }
    // Post-merge re-scan: when work lands in done, hint the regen edge.
    if (ev.to === 'done') flashEdge('rescan:regen');
    model = applyEvent(model, ev);
    renderCounts();
    return;
  }
  if (ev.type === 'ticket.upsert') {
    const isNew = !hasTicket(model, ev.ticket?.id ?? ev.id);
    model = applyEvent(model, ev);
    renderCounts();
    if (isNew && ev.state === 'needs-triage' && !REDUCED) {
      animatePath(['spine:triage'], colorForTicket(ev.ticket));
    } else if (isNew) {
      flashNode(ev.state);
    }
    return;
  }
  if (ev.type === 'ticket.remove') {
    model = applyEvent(model, ev);
    renderCounts();
    flashNode(ev.state);
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
