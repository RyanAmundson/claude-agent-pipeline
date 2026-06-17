// Features tab controller. Renders the feature:* flow + the shared
// self-improvement band into #feature-graph, fed by the same /api/v1 snapshot
// and SSE stream as the pipeline tab. Features are ordinary tickets, so counts
// come straight from snapshot.tickets.byState. Empty state until any exist.

import {
  FEATURE_NODES, FEATURE_EDGES, FEATURE_VIEW,
  featureCountsOf, childrenByEpic, isEmptyCounts,
} from './feature-graph.js';
import { META_NODES, META_EDGES } from './metaloop-graph.js';
import { buildStaticGraph, renderStaticCounts } from './graph-render.js';

let built = false;
let svg = null;
let emptyEl = null;
let statusEl = null;
let featureNodeEls = null;
let lastSnapshot = null;
let es = null;

function build() {
  svg = document.getElementById('feature-graph');
  emptyEl = document.getElementById('feature-empty');
  statusEl = document.getElementById('feature-status');
  if (!svg) return false;
  svg.setAttribute('viewBox', `0 0 ${FEATURE_VIEW.w} ${FEATURE_VIEW.h}`);
  const flow = buildStaticGraph(svg, { nodes: FEATURE_NODES, edges: FEATURE_EDGES });
  featureNodeEls = flow.nodeEls;
  // Shared self-improvement band beneath the feature flow.
  buildStaticGraph(svg, { nodes: META_NODES, edges: META_EDGES });
  // Building drill-in: clicking the building node toggles its child-ticket panel.
  const building = featureNodeEls.get('feature:building');
  if (building) {
    building.g.style.cursor = 'pointer';
    building.g.addEventListener('click', toggleDrill);
  }
  return true;
}

// Render the building epics' child tickets (grouped by epic) as state-colored chips.
function toggleDrill() {
  const drill = document.getElementById('feature-drill');
  if (!drill) return;
  if (!drill.hidden) { drill.hidden = true; return; }
  drill.textContent = '';
  const byEpic = childrenByEpic(lastSnapshot || {});
  const epics = Object.keys(byEpic);
  if (!epics.length) {
    const p = document.createElement('p');
    p.className = 'dim';
    p.textContent = 'No child tickets linked to a building epic yet.';
    drill.append(p);
  } else {
    for (const epic of epics) {
      const row = document.createElement('div');
      row.className = 'feature-epic';
      const id = document.createElement('span');
      id.className = 'feature-epic-id';
      id.textContent = epic;
      row.append(id);
      for (const c of byEpic[epic]) {
        const chip = document.createElement('span');
        chip.className = `feature-child-chip kind-${c.state}`;
        chip.textContent = `${c.id} · ${c.state}`;
        row.append(chip);
      }
      drill.append(row);
    }
  }
  drill.hidden = false;
}

function apply(snapshot) {
  lastSnapshot = snapshot;
  const counts = featureCountsOf(snapshot);
  renderStaticCounts(featureNodeEls, FEATURE_NODES, counts);
  const empty = isEmptyCounts(counts);
  if (emptyEl) emptyEl.hidden = !empty;
  if (statusEl) {
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    statusEl.textContent = empty ? '' : `${total} feature ticket${total === 1 ? '' : 's'} in flight`;
  }
}

function connect() {
  if (es) es.close();
  es = new EventSource('/api/v1/events');
  es.onmessage = ev => {
    let data; try { data = JSON.parse(ev.data); } catch { return; }
    if (data.type === 'snapshot') apply(data.data);
    else if (data.type === 'ticket.move' || data.type === 'ticket.upsert' || data.type === 'ticket.remove') {
      // feature counts are cheap to refetch; keep it simple and authoritative
      fetch('/api/v1/snapshot').then(r => r.json()).then(apply).catch(() => {});
    }
  };
  es.onerror = () => { es.close(); es = null; setTimeout(connect, 3000); };
}

export function initFeatures() {
  if (built) return;
  if (!build()) return;
  built = true;
  fetch('/api/v1/snapshot').then(r => r.json()).then(apply).catch(() => {
    if (statusEl) statusEl.textContent = 'failed to load features';
  });
  connect();
}
