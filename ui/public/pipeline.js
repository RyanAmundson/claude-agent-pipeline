// Pipeline graph view. Builds an SVG from the pure topology module, shows live
// per-node counts and running-agent pulses, and (Task 7) animates ticket tokens.
// Browser-only; the pure logic lives in pipeline-graph.js.

import {
  NODES, EDGES, VIEW, pathFor,
  seedModel, applyEvent, countsOf, hasTicket, pathEdgesForMove,
  countsFromCycle, countSourceForCycle,
  agentCountsByNode, runningAgentNames,
  backPressureByNode, provisioningEvents, dispatchEdgeId,
} from './pipeline-graph.js';
import { colorForAgent } from './colors.js';
import { buildAgentsBand } from './graph-render.js';
import { bandLayout } from './agents-band-graph.js';

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
// Per-node running-agent counts from the previous render, so we can detect when
// the orchestrator provisions a new agent (count rose) and pulse a dispatch down
// to that step. Seeded on first render so the initial fleet doesn't all "fire".
let prevAgentsByNode = {};
let agentsSeeded = false;

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
    // Back-pressure halo (amber, outside the box) — shown only when this node's
    // queue outruns its agents. Drawn before the box so the box sits on top.
    if (n.state) g.append(el('rect', { class: 'pl-node-pressure', x: -57, y: -27, width: 114, height: 54, rx: 9 }));
    g.append(el('rect', { class: 'pl-node-box', x: -52, y: -22, width: 104, height: 44, rx: 6 }));
    const label = el('text', { class: 'pl-node-label', y: n.agent ? -2 : 5 });
    label.textContent = n.label;
    g.append(label);
    if (n.agent) {
      const ag = el('text', { class: 'pl-node-agent', y: 13 });
      ag.textContent = n.agent;
      g.append(ag);
    }
    // Ticket backlog badge (top-right, accent).
    const countBg = el('circle', { class: 'pl-node-countbg', cx: 52, cy: -22, r: 9 });
    const countText = el('text', { class: 'pl-node-count', x: 52, y: -18.5 });
    g.append(countBg, countText);
    // Active-agent badge (bottom-right, ok-green) — only on the node where this
    // agent actually works (its `agentHome`), so it reads as allocation vs the
    // backlog the ticket badge shows.
    let agentBg = null, agentText = null;
    if (n.agent && n.agentHome !== false) {
      agentBg = el('circle', { class: 'pl-node-agentbg', cx: 52, cy: 22, r: 9 });
      agentText = el('text', { class: 'pl-node-agentcount', x: 52, y: 25.5 });
      g.append(agentBg, agentText);
    }
    nodeEls.set(id, { g, title, countText, countBg, agentBg, agentText });
    nodeLayer.append(g);
  }

  // Legend: distinguishes the badges + the back-pressure halo.
  const legend = el('g', { class: 'pl-legend', transform: 'translate(24,22)' });
  const swatch = (cx, cls) => el('circle', { class: cls, cx, cy: 0, r: 6 });
  const lbl = (x, t) => { const e = el('text', { class: 'pl-legend-label', x, y: 4 }); e.textContent = t; return e; };
  legend.append(swatch(0, 'pl-node-countbg'), lbl(10, 'tickets queued'),
                swatch(120, 'pl-node-agentbg'), lbl(130, 'agents working'),
                swatch(248, 'pl-legend-pressure'), lbl(258, 'back-pressure'));
  nodeLayer.append(legend);

  svg.append(edgeLayer, tokenLayer, nodeLayer);

  // Agents band: the off-spine fleet the orchestrator dispatches, stacked in
  // columns under the spine stage each agent works at (so a tall column shows
  // where work concentrates). Appended into the same SVG beneath the spine.
  const { chips, feeds } = bandLayout(NODES);
  buildAgentsBand(svg, { chips, feeds, spineNodes: NODES });
  return true;
}

// Per-state counts from whichever source the current backend trusts.
function currentCounts() {
  return countSourceForCycle(latestCycle) === 'cycle'
    ? countsFromCycle(latestCycle)
    : countsOf(model);
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

// How many agents are working at each node, plus the two derived load-balancer
// signals: which stages are under back-pressure (queue deeper than its agents),
// and where the orchestrator just provisioned (agent count rose since last time).
// The running list comes from the cycle report when present (the orchestrator's
// authoritative dispatch list, and the only signal on Linear/GitHub), else from
// filesystem run records — see runningAgentNames().
function renderAgents() {
  const byNode = agentCountsByNode(runningAgentNames(lastSnapshot, latestCycle));
  const pressure = backPressureByNode(currentCounts(), byNode);

  for (const [id, n] of Object.entries(NODES)) {
    const els = nodeEls.get(id);
    const c = (n.agent && n.agentHome !== false) ? (byNode[id] || 0) : 0;
    if (els.agentText) els.agentText.textContent = String(c);
    els.g.classList.toggle('has-agents', c > 0);
    els.g.classList.toggle('running', c > 0);
    // Back-pressure halo on the queue node that's outrunning its agents.
    const p = pressure[id] || 0;
    els.g.classList.toggle('pressure', p > 0);
    if (n.state) {
      const base = n.agent ? `${n.label} — ${n.agent}` : n.label;
      els.title.textContent = p > 0 ? `${base} · back-pressure: ${p}` : base;
    }
  }

  // Orchestrator provisioning: pulse a dispatch from the orchestrator down to any
  // stage whose agent count just rose. Seed silently on the first render.
  if (agentsSeeded) {
    for (const { node, added } of provisioningEvents(prevAgentsByNode, byNode)) {
      pulseDispatch(node, added);
    }
  }
  prevAgentsByNode = byNode;
  agentsSeeded = true;
}

// Pulse the orchestrator's control-plane edge to a stage it's provisioning: flash
// the orchestrator, light the (normally invisible) dispatch line, and send one
// green token per added agent (capped) down to the node.
function pulseDispatch(node, added = 1) {
  flashNode('orchestrator');
  const edgeId = dispatchEdgeId(node);
  const edge = edgeEls.get(edgeId);
  if (REDUCED || !edge) { flashNode(node); return; }
  edge.classList.add('active');
  const n = Math.min(added, 3);
  let pending = n;
  const done = () => { if (--pending <= 0) { edge.classList.remove('active'); flashNode(node); } };
  for (let i = 0; i < n; i++) {
    setTimeout(() => spawnToken(edgeId, null, done, 'dispatch'), i * 140);
  }
}

function updateStatus() {
  if (!statusEl) return;
  const tickets = Object.values(currentCounts()).reduce((a, b) => a + b, 0);
  const agents = Object.values(agentCountsByNode(runningAgentNames(lastSnapshot, latestCycle)))
    .reduce((a, b) => a + b, 0);
  const via = countSourceForCycle(latestCycle) === 'cycle' ? ` · ${latestCycle.backend}` : '';
  statusEl.textContent =
    `${tickets} ticket${tickets === 1 ? '' : 's'} · ${agents} agent${agents === 1 ? '' : 's'} working${via}`;
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
  renderAgents();
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

function spawnToken(edgeId, color, onDone, cls) {
  const pathEl = edgeEls.get(edgeId);
  if (!pathEl) { onDone && onDone(); return; }
  const len = pathEl.getTotalLength();
  const dot = el('circle', { class: cls ? `pl-token ${cls}` : 'pl-token', r: TOKEN_R, cx: 0, cy: 0 });
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
    renderAgents();
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
