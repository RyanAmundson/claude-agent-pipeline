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
