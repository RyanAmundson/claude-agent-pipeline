import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BAND_AGENTS, BAND_ROW_Y, BAND_ROW_LABELS, bandLayout,
} from '../../ui/public/agents-band-graph.js';
import { NODES, VIEW, pathFor } from '../../ui/public/pipeline-graph.js';

test('every band agent feeds a spine node that exists', () => {
  for (const a of BAND_AGENTS) {
    assert.ok(NODES[a.feeds], `agent ${a.id} feeds unknown spine node ${a.feeds}`);
  }
});

test('every band agent sits in a defined row with a caption', () => {
  for (const a of BAND_AGENTS) {
    assert.ok(BAND_ROW_Y[a.row] != null, `agent ${a.id} in unknown row ${a.row}`);
    assert.ok(BAND_ROW_LABELS[a.row], `row ${a.row} has no caption`);
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

test('the band sits below the spine and within the canvas', () => {
  // Spine + its lower lanes end ~y432; the canvas is VIEW.h tall.
  for (const [row, y] of Object.entries(BAND_ROW_Y)) {
    assert.ok(y > 432, `row ${row} (${y}) must sit below the spine`);
    assert.ok(y + 13 <= VIEW.h, `row ${row} (${y}) must fit within VIEW.h=${VIEW.h}`);
  }
});

test('bandLayout positions a chip + a feed for every agent, within the canvas', () => {
  const { chips, feeds } = bandLayout(VIEW, BAND_ROW_Y);
  assert.equal(Object.keys(chips).length, BAND_AGENTS.length);
  assert.equal(feeds.length, BAND_AGENTS.length);
  for (const a of BAND_AGENTS) {
    const c = chips[a.id];
    assert.ok(c, `no chip for ${a.id}`);
    assert.ok(c.x - c.w / 2 >= 0 && c.x + c.w / 2 <= VIEW.w, `chip ${a.id} overflows canvas width`);
  }
});

test('every feed renders to an SVG path against merged spine+chip coords', () => {
  const { chips, feeds } = bandLayout(VIEW, BAND_ROW_Y);
  const coords = { ...NODES, ...chips };
  for (const f of feeds) {
    const d = pathFor({ from: f.from, to: f.to }, coords);
    assert.ok(typeof d === 'string' && d.startsWith('M'), `feed ${f.id} did not render`);
  }
});
