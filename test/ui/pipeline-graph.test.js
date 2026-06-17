import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NODES, EDGES, VIEW, pathEdgesForMove,
} from '../../ui/public/pipeline-graph.js';

test('every edge references defined nodes', () => {
  for (const e of EDGES) {
    assert.ok(NODES[e.from], `edge ${e.id} from-node ${e.from} missing`);
    assert.ok(NODES[e.to], `edge ${e.id} to-node ${e.to} missing`);
  }
});

test('VIEW has positive dimensions', () => {
  assert.ok(VIEW.w > 0 && VIEW.h > 0);
});

test('happy-path move resolves to its single spine edge', () => {
  assert.deepEqual(pathEdgesForMove('needs-triage', 'needs-review'), ['spine:review']);
});

test('happy path chains code-review → regression → feature-validation → ready', () => {
  assert.deepEqual(pathEdgesForMove('needs-code-review', 'needs-regression-check'), ['spine:regression']);
  assert.deepEqual(pathEdgesForMove('needs-regression-check', 'needs-feature-validation'), ['spine:featureval']);
  assert.deepEqual(pathEdgesForMove('needs-feature-validation', 'ready-for-human'), ['spine:ready']);
});

test('gate FAILs loop back to needs-feedback', () => {
  assert.deepEqual(pathEdgesForMove('needs-regression-check', 'needs-feedback'), ['fail:regression']);
  assert.deepEqual(pathEdgesForMove('needs-feature-validation', 'needs-feedback'), ['fail:featureval']);
});

test('review FAIL loops back to needs-feedback', () => {
  assert.deepEqual(pathEdgesForMove('needs-code-review', 'needs-feedback'), ['fail:codereview']);
  assert.deepEqual(pathEdgesForMove('needs-test-review', 'needs-feedback'), ['fail:test']);
});

test('feedback re-review returns to code-review', () => {
  assert.deepEqual(pathEdgesForMove('needs-feedback', 'needs-code-review'), ['feedback:rereview']);
});

test('human comment re-enters at needs-feedback', () => {
  assert.deepEqual(pathEdgesForMove('ready-for-human', 'needs-feedback'), ['human:reentry']);
});

test('merge routes through the human, then to done (multi-hop)', () => {
  assert.deepEqual(pathEdgesForMove('ready-for-human', 'done'), ['handoff:human', 'merge:done']);
});

test('park and resume via needs-info', () => {
  assert.deepEqual(pathEdgesForMove('needs-review', 'needs-info'), ['park:info']);
  assert.deepEqual(pathEdgesForMove('needs-info', 'needs-review'), ['info:resume']);
});

test('stale in-progress re-queues to needs-work', () => {
  assert.deepEqual(pathEdgesForMove('in-progress', 'needs-work'), ['stale:requeue']);
});

test('obsolete exits are wired', () => {
  assert.deepEqual(pathEdgesForMove('needs-work', 'obsolete'), ['obsolete:work']);
  assert.deepEqual(pathEdgesForMove('ready-for-human', 'obsolete'), ['obsolete:ready']);
});

test('entry move (scanner→triage) resolves to the entry spine edge', () => {
  assert.deepEqual(pathEdgesForMove('scanner', 'needs-triage'), ['spine:triage']);
});

test('an unmodeled move returns an empty path', () => {
  assert.deepEqual(pathEdgesForMove('done', 'in-progress'), []);
});

import { pathFor } from '../../ui/public/pipeline-graph.js';

test('pathFor returns a quadratic bezier between node centers', () => {
  const d = pathFor(EDGES.find(e => e.id === 'spine:review'));
  // M <ax> <ay> Q <cx> <cy> <bx> <by>
  assert.match(d, /^M 190 250 Q [\d.-]+ [\d.-]+ 310 250$/);
});

test('a zero-bend edge keeps the control point on the chord midpoint', () => {
  const d = pathFor({ from: 'needs-triage', to: 'needs-review', bend: 0 });
  assert.match(d, /^M 190 250 Q 250(\.0)? 250(\.0)? 310 250$/);
});

test('a non-zero bend pushes the control point off the chord', () => {
  const straight = pathFor({ from: 'needs-review', to: 'needs-info', bend: 0 });
  const bowed = pathFor({ from: 'needs-review', to: 'needs-info', bend: 40 });
  assert.notEqual(straight, bowed);
});

import { seedModel, applyEvent, countsOf, hasTicket } from '../../ui/public/pipeline-graph.js';

const SNAP = {
  tickets: { byState: {
    'needs-work': [{ id: 'A' }, { id: 'B' }],
    'in-progress': [{ id: 'C' }],
    'ready-for-human': [{ id: 'D' }],
  } },
};

test('seedModel + countsOf reflect the snapshot', () => {
  const counts = countsOf(seedModel(SNAP));
  assert.equal(counts['needs-work'], 2);
  assert.equal(counts['in-progress'], 1);
  assert.equal(counts['ready-for-human'], 1);
  assert.equal(counts['needs-triage'], 0);
});

test('a move decrements the source and increments the destination', () => {
  let m = seedModel(SNAP);
  m = applyEvent(m, { type: 'ticket.move', id: 'A', from: 'needs-work', to: 'in-progress' });
  const counts = countsOf(m);
  assert.equal(counts['needs-work'], 1);
  assert.equal(counts['in-progress'], 2);
});

test('upsert of a new id adds it; re-upsert is idempotent', () => {
  let m = seedModel(SNAP);
  m = applyEvent(m, { type: 'ticket.upsert', state: 'needs-triage', ticket: { id: 'Z' } });
  assert.equal(countsOf(m)['needs-triage'], 1);
  m = applyEvent(m, { type: 'ticket.upsert', state: 'needs-triage', ticket: { id: 'Z' } });
  assert.equal(countsOf(m)['needs-triage'], 1);
});

test('remove drops the id from its state', () => {
  let m = seedModel(SNAP);
  m = applyEvent(m, { type: 'ticket.remove', id: 'D', state: 'ready-for-human' });
  assert.equal(countsOf(m)['ready-for-human'], 0);
});

test('hasTicket reports prior membership (for entry detection)', () => {
  const m = seedModel(SNAP);
  assert.equal(hasTicket(m, 'A'), true);
  assert.equal(hasTicket(m, 'Z'), false);
});

import {
  countsFromCycle, runningAgentsFromCycle, countSourceForCycle,
} from '../../ui/public/pipeline-graph.js';

// ─── Linear/GitHub backend: counts + running come from the cycle report ──────
// On non-filesystem backends there is no queue to watch, so the orchestrator's
// cycle.report is the only source of per-state counts and which agents run.

test('countsFromCycle zero-fills known states and overlays cycle counts', () => {
  const c = countsFromCycle({ counts: { 'needs-work': 3, 'ready-for-human': 1, bogus: 9 } });
  assert.equal(c['needs-work'], 3);
  assert.equal(c['ready-for-human'], 1);
  assert.equal(c['needs-triage'], 0);   // zero-filled
  assert.equal('bogus' in c, false);    // unknown state ignored
});

test('countsFromCycle handles a null/empty cycle', () => {
  assert.equal(countsFromCycle(null)['needs-work'], 0);
  assert.equal(countsFromCycle({})['done'], 0);
});

test('runningAgentsFromCycle extracts agent names (skips malformed)', () => {
  assert.deepEqual(
    runningAgentsFromCycle({ running: [{ agent: 'code-reviewer', item: '#1' }, { agent: 'tester' }, { item: 'x' }] }),
    ['code-reviewer', 'tester'],
  );
  assert.deepEqual(runningAgentsFromCycle(null), []);
});

test('countSourceForCycle: filesystem→model, linear/github→cycle, none→model', () => {
  assert.equal(countSourceForCycle({ backend: 'filesystem' }), 'model');
  assert.equal(countSourceForCycle({ backend: 'linear' }), 'cycle');
  assert.equal(countSourceForCycle({ backend: 'github' }), 'cycle');
  assert.equal(countSourceForCycle(null), 'model');
});

import {
  agentHomeNodes, agentCountsByNode, runningAgentNames,
} from '../../ui/public/pipeline-graph.js';

// ─── per-node agent allocation (back-pressure view) ─────────────────────────
// Each running agent counts at the node where it actively works, so a node can
// show both its ticket backlog and how many agents are on it.

test('agentHomeNodes maps each agent to its single work-home node', () => {
  const home = agentHomeNodes();
  assert.equal(home['worker'], 'in-progress');        // not needs-work (backlog)
  assert.equal(home['ticket-reviewer'], 'needs-review'); // not needs-info (park)
  assert.equal(home['code-reviewer'], 'needs-code-review');
  assert.equal(home['tester'], 'needs-test-review');
  assert.equal(home['cleanup'], 'done');
  assert.equal(home['relevance-checker'], 'obsolete');
  assert.equal(home['orchestrator'], 'orchestrator');
});

test('agentCountsByNode tallies running instances onto home nodes', () => {
  const c = agentCountsByNode(['worker', 'worker', 'code-reviewer', 'tester']);
  assert.equal(c['in-progress'], 2);     // two workers
  assert.equal(c['needs-code-review'], 1);
  assert.equal(c['needs-test-review'], 1);
  assert.equal(c['needs-work'], undefined);   // backlog node never gets an agent count
});

test('agentCountsByNode ignores agents with no modeled node', () => {
  const c = agentCountsByNode(['ghost-agent', 'worker']);
  assert.equal(c['in-progress'], 1);
  assert.equal('ghost-agent' in c, false);
});

test('runningAgentNames prefers cycle.running when present (Linear/GitHub)', () => {
  const names = runningAgentNames(
    { agents: [{ name: 'worker', activity: { runs: [{ runId: 'r' }] } }] },
    { running: [{ agent: 'code-reviewer' }, { agent: 'code-reviewer' }] },
  );
  assert.deepEqual(names, ['code-reviewer', 'code-reviewer']);  // cycle wins, no double count
});

test('runningAgentNames falls back to filesystem run records', () => {
  const names = runningAgentNames(
    { agents: [
      { name: 'worker', activity: { runs: [{ runId: 'a' }, { runId: 'b' }] } },
      { name: 'tester', activity: { runs: [] } },
    ] },
    null,
  );
  assert.deepEqual(names.sort(), ['worker', 'worker']);
});

// ─── back-pressure + orchestrator provisioning ──────────────────────────────
import {
  STAGES, backPressureByNode, provisioningEvents, dispatchEdgeId,
} from '../../ui/public/pipeline-graph.js';

test('every stage drains a real queue and (except the worker) is its own node', () => {
  for (const s of STAGES) {
    assert.ok(NODES[s.node], `stage node ${s.node} missing`);
    assert.ok(NODES[s.queue], `stage queue ${s.queue} missing`);
  }
  // the worker is the special case: home node ≠ inbound queue
  const worker = STAGES.find(s => s.node === 'in-progress');
  assert.equal(worker.queue, 'needs-work');
});

test('backPressureByNode flags queues deeper than their agents, keyed by queue node', () => {
  const counts = { 'needs-code-review': 3, 'needs-review': 1, 'needs-work': 4 };
  const agents = { 'needs-code-review': 2, 'needs-review': 1, 'in-progress': 1 };
  const bp = backPressureByNode(counts, agents);
  assert.equal(bp['needs-code-review'], 1);   // 3 queued − 2 agents
  assert.equal('needs-review' in bp, false);  // 1 queued, 1 agent → covered
  assert.equal(bp['needs-work'], 3);          // worker backlog: 4 − 1 worker, shown on needs-work
});

test('backPressureByNode is empty when every queue is covered', () => {
  const bp = backPressureByNode({ 'needs-review': 2 }, { 'needs-review': 2 });
  assert.deepEqual(bp, {});
});

test('backPressureByNode tolerates missing counts/agents', () => {
  assert.deepEqual(backPressureByNode(null, null), {});
  assert.deepEqual(backPressureByNode({ 'needs-review': 2 }, null), { 'needs-review': 2 });
});

test('provisioningEvents reports nodes where the agent count rose', () => {
  const ev = provisioningEvents(
    { 'in-progress': 1, 'needs-code-review': 2 },
    { 'in-progress': 3, 'needs-code-review': 2, 'needs-test-review': 1 },
  );
  const byNode = Object.fromEntries(ev.map(e => [e.node, e.added]));
  assert.equal(byNode['in-progress'], 2);       // 1 → 3
  assert.equal(byNode['needs-test-review'], 1); // 0 → 1 (new)
  assert.equal('needs-code-review' in byNode, false); // unchanged
});

test('provisioningEvents ignores decreases and first-seen empty prev', () => {
  assert.deepEqual(provisioningEvents({ 'in-progress': 3 }, { 'in-progress': 1 }), []);
  assert.deepEqual(provisioningEvents(null, {}), []);
});

test('dispatchEdgeId maps a stage node to its orchestrator dispatch edge', () => {
  const id = dispatchEdgeId('in-progress');
  const edge = EDGES.find(e => e.id === id);
  assert.ok(edge, 'dispatch edge exists');
  assert.equal(edge.from, 'orchestrator');
  assert.equal(edge.to, 'in-progress');
  assert.equal(edge.kind, 'dispatch');
});

test('every stage has an orchestrator dispatch edge', () => {
  for (const s of STAGES) {
    const edge = EDGES.find(e => e.id === dispatchEdgeId(s.node));
    assert.ok(edge, `stage ${s.node} has a dispatch edge`);
    assert.equal(edge.from, 'orchestrator');
  }
});

// ─── conflict-resolver detour ───────────────────────────────────────────────
test('needs-conflict-resolution node exists with conflict-resolver as its agent', () => {
  const n = NODES['needs-conflict-resolution'];
  assert.ok(n, 'needs-conflict-resolution node missing');
  assert.equal(n.agent, 'conflict-resolver');
  assert.equal(n.state, 'needs-conflict-resolution');
});

test('the conflict detour and return are wired both ways', () => {
  assert.deepEqual(pathEdgesForMove('ready-for-human', 'needs-conflict-resolution'), ['conflict:detour']);
  assert.deepEqual(pathEdgesForMove('needs-conflict-resolution', 'ready-for-human'), ['conflict:resolved']);
});

test('conflict-resolver has a home node and a dispatch edge', () => {
  assert.equal(agentHomeNodes()['conflict-resolver'], 'needs-conflict-resolution');
  const d = EDGES.find(e => e.id === 'dispatch:needs-conflict-resolution');
  assert.ok(d, 'dispatch edge missing');
  assert.equal(d.from, 'orchestrator');
  assert.equal(d.to, 'needs-conflict-resolution');
});

test('VIEW grew tall enough for the self-improvement band', () => {
  assert.ok(VIEW.h >= 720, `VIEW.h is ${VIEW.h}, expected >= 720`);
});
