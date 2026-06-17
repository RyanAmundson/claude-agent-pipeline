import { test } from 'node:test';
import assert from 'node:assert/strict';
import { META_NODES, META_EDGES, BAND_ORIGIN_Y } from '../../ui/public/metaloop-graph.js';
import { pathFor } from '../../ui/public/pipeline-graph.js';

test('every meta edge references a defined meta node', () => {
  for (const e of META_EDGES) {
    assert.ok(META_NODES[e.from], `edge ${e.id} from ${e.from} missing`);
    assert.ok(META_NODES[e.to], `edge ${e.id} to ${e.to} missing`);
  }
});

test('the four self-improvement agents and the corpus/findings/pr nodes exist', () => {
  for (const id of ['corpus', 'transcript-reviewer', 'pipeline-evaluator',
    'findings', 'agent-improver', 'agent-architect', 'improvement-pr']) {
    assert.ok(META_NODES[id], `meta node ${id} missing`);
  }
});

test('the loop closes with a feedback edge from the PR back to the corpus', () => {
  const fb = META_EDGES.find(e => e.kind === 'feedback');
  assert.ok(fb, 'no feedback edge');
  assert.equal(fb.from, 'improvement-pr');
  assert.equal(fb.to, 'corpus');
});

test('the band sits below the spine and pathFor renders a meta edge', () => {
  assert.ok(BAND_ORIGIN_Y >= 560, 'band must sit below the 560px spine region');
  const d = pathFor(META_EDGES.find(e => e.id === 'meta:tr-findings'), META_NODES);
  assert.equal(typeof d, 'string');
  assert.ok(d.startsWith('M') && d.length > 5, `expected an SVG path, got ${d}`);
});
