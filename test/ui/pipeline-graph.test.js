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
  assert.deepEqual(pathEdgesForMove('needs-code-review', 'ready-for-human'), ['spine:ready']);
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
  assert.match(d, /^M 210 250 Q [\d.-]+ [\d.-]+ 340 250$/);
});

test('a zero-bend edge keeps the control point on the chord midpoint', () => {
  const d = pathFor({ from: 'needs-triage', to: 'needs-review', bend: 0 });
  assert.match(d, /^M 210 250 Q 275(\.0)? 250(\.0)? 340 250$/);
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
