import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NODES, EDGES, VIEW, EPIC_STATES, pathEdgesForMove,
  seedEpicModel, applyEpicEvent, epicCountsOf, childProgress,
} from '../../ui/public/feature-pipeline-graph.js';

test('every edge references a defined node', () => {
  for (const e of EDGES) {
    assert.ok(NODES[e.from], `edge ${e.id} from ${e.from} missing`);
    assert.ok(NODES[e.to], `edge ${e.id} to ${e.to} missing`);
  }
});

test('VIEW has positive dimensions', () => {
  assert.ok(VIEW.w > 0 && VIEW.h > 0);
});

test('the front spine is wired spec→design→decompose→building', () => {
  assert.deepEqual(pathEdgesForMove('needs-spec', 'needs-design'), ['spine:design']);
  assert.deepEqual(pathEdgesForMove('needs-design', 'needs-decomposition'), ['spine:decompose']);
  assert.deepEqual(pathEdgesForMove('needs-decomposition', 'building'), ['spine:building']);
});

test('the back spine is wired building→integrate→accept→ready', () => {
  assert.deepEqual(pathEdgesForMove('building', 'needs-integration'), ['spine:integrate']);
  assert.deepEqual(pathEdgesForMove('needs-integration', 'needs-acceptance'), ['spine:accept']);
  assert.deepEqual(pathEdgesForMove('needs-acceptance', 'ready-for-human'), ['spine:ready']);
});

test('acceptance failure loops to needs-feedback and back', () => {
  assert.deepEqual(pathEdgesForMove('needs-acceptance', 'needs-feedback'), ['fail:accept']);
  assert.deepEqual(pathEdgesForMove('needs-feedback', 'needs-acceptance'), ['feedback:revalidate']);
});

test('an unmodeled move returns an empty path', () => {
  assert.deepEqual(pathEdgesForMove('done', 'building'), []);
});

const SNAP = {
  epics: { byState: {
    'needs-spec': [{ id: 'EPIC-002' }],
    'building': [{ id: 'EPIC-001', children: ['EPIC-001-1', 'EPIC-001-2', 'EPIC-001-3'] }],
  } },
  tickets: { byState: {
    'needs-work': [{ id: 'EPIC-001-3', epic: 'EPIC-001' }],
    'needs-code-review': [{ id: 'EPIC-001-2', epic: 'EPIC-001' }],
    'done': [{ id: 'EPIC-001-1', epic: 'EPIC-001' }, { id: 'TKT-900' }],
  } },
};

test('seedEpicModel + epicCountsOf reflect the snapshot', () => {
  const c = epicCountsOf(seedEpicModel(SNAP));
  assert.equal(c['needs-spec'], 1);
  assert.equal(c['building'], 1);
  assert.equal(c['done'], 0);
});

test('applyEpicEvent move reassigns an epic state', () => {
  let m = seedEpicModel(SNAP);
  m = applyEpicEvent(m, { type: 'epic.move', id: 'EPIC-002', from: 'needs-spec', to: 'needs-design' });
  const c = epicCountsOf(m);
  assert.equal(c['needs-spec'], 0);
  assert.equal(c['needs-design'], 1);
});

test('childProgress groups an epic\'s children by their ticket state, ignoring non-children', () => {
  const p = childProgress(SNAP, 'EPIC-001');
  assert.equal(p.total, 3);
  assert.equal(p.byState['needs-work'], 1);
  assert.equal(p.byState['needs-code-review'], 1);
  assert.equal(p.byState['done'], 1);
  assert.equal(p.ready, 1);          // children in done
});
