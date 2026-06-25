import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as gr from '../../ui/public/graph-render.js';

test('graph-render exports the static builder and count renderer', () => {
  assert.equal(typeof gr.buildStaticGraph, 'function');
  assert.equal(typeof gr.renderStaticCounts, 'function');
});
