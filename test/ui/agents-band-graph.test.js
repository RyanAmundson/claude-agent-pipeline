import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BAND_AGENTS, BAND_TOP, CHIP_H, CHIP_W, bandLayout,
} from '../../ui/public/agents-band-graph.js';
import { NODES, VIEW, pathFor } from '../../ui/public/pipeline-graph.js';

test('every band agent works at a spine stage that exists', () => {
  for (const a of BAND_AGENTS) {
    assert.ok(NODES[a.stage], `agent ${a.id} has unknown stage ${a.stage}`);
  }
});

test('the removed self-improvement agents are NOT in the band', () => {
  const ids = new Set(BAND_AGENTS.map(a => a.id));
  for (const gone of ['transcript-reviewer', 'pipeline-evaluator', 'agent-improver', 'agent-architect']) {
    assert.ok(!ids.has(gone), `${gone} should have been removed with the metaloop band`);
  }
});

test('all eleven detectors are represented', () => {
  const detectors = BAND_AGENTS.filter(a => a.id.endsWith('-detector')).map(a => a.id);
  assert.equal(detectors.length, 11, `expected 11 detectors, got ${detectors.length}`);
});

test('the ticket-reviewer sits under review, not code-review', () => {
  const tr = BAND_AGENTS.find(a => a.id === 'ticket-reviewer');
  assert.ok(tr, 'ticket-reviewer missing from the band');
  assert.equal(tr.stage, 'needs-review');
});

test('the detector panel concentrates under code-review', () => {
  const atCodeReview = BAND_AGENTS.filter(a => a.stage === 'needs-code-review');
  // 10 detectors (security works at triage) + the two data reviewers.
  assert.equal(atCodeReview.length, 12, `expected 12 agents at code-review, got ${atCodeReview.length}`);
});

test('bandLayout anchors each chip under its stage x, in a downward column', () => {
  const { chips } = bandLayout(NODES);
  assert.equal(Object.keys(chips).length, BAND_AGENTS.length);
  // group by stage and assert shared x + monotonic, BAND_TOP-anchored y.
  const byStage = new Map();
  for (const a of BAND_AGENTS) {
    if (!byStage.has(a.stage)) byStage.set(a.stage, []);
    byStage.get(a.stage).push(a.id);
  }
  for (const [stage, ids] of byStage) {
    ids.forEach((id, i) => {
      assert.equal(chips[id].x, NODES[stage].x, `${id} not aligned under ${stage}`);
      assert.equal(chips[id].y, BAND_TOP + i * 20, `${id} not stacked at row ${i}`);
    });
  }
});

test('the tallest column fits within the canvas and clears the spine lower lane', () => {
  const { chips } = bandLayout(NODES);
  for (const c of Object.values(chips)) {
    assert.ok(c.y - CHIP_H / 2 > 432, 'a chip overlaps the spine lower lane (~y432)');
    assert.ok(c.y + CHIP_H / 2 <= VIEW.h, `a chip overflows VIEW.h=${VIEW.h}`);
    assert.ok(c.x - CHIP_W / 2 >= 0 && c.x + CHIP_W / 2 <= VIEW.w, 'a chip overflows the canvas width');
  }
});

test('one feed stem per column renders to an SVG path against merged coords', () => {
  const { chips, feeds } = bandLayout(NODES);
  const stages = new Set(BAND_AGENTS.map(a => a.stage));
  assert.equal(feeds.length, stages.size, 'expected exactly one feed per stage column');
  const coords = { ...NODES, ...chips };
  for (const f of feeds) {
    assert.ok(NODES[f.from], `feed ${f.id} from a non-stage node`);
    const d = pathFor({ from: f.from, to: f.to }, coords);
    assert.ok(typeof d === 'string' && d.startsWith('M'), `feed ${f.id} did not render`);
  }
});
