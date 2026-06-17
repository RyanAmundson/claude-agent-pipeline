import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FEATURE_NODES, FEATURE_EDGES, FEATURE_VIEW,
  featureCountsOf, childrenByEpic, isEmptyCounts,
} from '../../ui/public/feature-graph.js';

test('every feature edge references a defined feature node', () => {
  for (const e of FEATURE_EDGES) {
    assert.ok(FEATURE_NODES[e.from], `edge ${e.id} from ${e.from} missing`);
    assert.ok(FEATURE_NODES[e.to], `edge ${e.id} to ${e.to} missing`);
  }
});

test('the feature lifecycle nodes exist and FEATURE_VIEW is positive', () => {
  for (const id of ['feature:needs-spec', 'feature:building', 'feature:ready-for-human']) {
    assert.ok(FEATURE_NODES[id], `node ${id} missing`);
  }
  assert.ok(FEATURE_VIEW.w > 0 && FEATURE_VIEW.h > 0);
});

test('featureCountsOf counts tickets per feature state, zero-filled', () => {
  const snap = { tickets: { byState: {
    'feature:building': [{ id: 'EPIC-1' }, { id: 'EPIC-2' }],
    'feature:needs-spec': [{ id: 'EPIC-3' }],
  } } };
  const counts = featureCountsOf(snap);
  assert.equal(counts['feature:building'], 2);
  assert.equal(counts['feature:needs-spec'], 1);
  assert.equal(counts['feature:ready-for-human'], 0);
});

test('childrenByEpic groups tickets carrying an epic field by their epic', () => {
  const snap = { tickets: { byState: {
    'needs-work': [{ id: 'T1', epic: 'EPIC-1' }, { id: 'T2', epic: 'EPIC-1' }],
    'needs-code-review': [{ id: 'T3', epic: 'EPIC-2' }, { id: 'T4' }],
  } } };
  const byEpic = childrenByEpic(snap);
  assert.equal(byEpic['EPIC-1'].length, 2);
  assert.deepEqual(byEpic['EPIC-1'].map(c => c.state).sort(), ['needs-work', 'needs-work']);
  assert.equal(byEpic['EPIC-2'][0].id, 'T3');
  assert.equal('undefined' in byEpic, false); // T4 (no epic) is not grouped
});

test('isEmptyCounts is true only when every state is zero', () => {
  assert.equal(isEmptyCounts({ 'feature:building': 0, 'feature:needs-spec': 0 }), true);
  assert.equal(isEmptyCounts({ 'feature:building': 1 }), false);
  assert.equal(isEmptyCounts({}), true);
});
