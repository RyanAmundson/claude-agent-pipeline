import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STATES, FEATURE_STATES, readSnapshot } from '../../api/index.js';

test('FEATURE_STATES is frozen and disjoint from the bug-fix STATES', () => {
  assert.ok(Object.isFrozen(FEATURE_STATES), 'FEATURE_STATES must be frozen');
  assert.ok(FEATURE_STATES.length > 0);
  for (const s of FEATURE_STATES) {
    assert.match(s, /^feature:/, `feature state ${s} must be feature:-prefixed`);
    assert.ok(!STATES.includes(s), `feature state ${s} must not be in bug-fix STATES`);
  }
});

test('FEATURE_STATES covers the lifecycle + side states', () => {
  for (const s of [
    'feature:needs-spec', 'feature:needs-design', 'feature:needs-decomposition',
    'feature:building', 'feature:needs-integration', 'feature:needs-acceptance',
    'feature:ready-for-human', 'feature:blocked', 'feature:needs-feedback',
  ]) assert.ok(FEATURE_STATES.includes(s), `missing ${s}`);
});

test('readSnapshot surfaces feature states (empty) without touching bug-fix byState', () => {
  const target = mkdtempSync(join(tmpdir(), 'ap-fs-'));
  mkdirSync(join(target, '.pipeline', 'queue'), { recursive: true });
  const snap = readSnapshot({ target });
  assert.deepEqual(snap.featureStates, FEATURE_STATES);
  for (const s of FEATURE_STATES) {
    assert.deepEqual(snap.tickets.byState[s], [], `${s} should be present and empty`);
  }
  // bug-fix states still present and empty — unchanged behavior
  assert.deepEqual(snap.tickets.byState['needs-triage'], []);
  assert.deepEqual(snap.states, STATES);
});
