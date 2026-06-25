import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as f from '../../ui/public/features.js';

test('features module exports initFeatures', () => {
  assert.equal(typeof f.initFeatures, 'function');
});
