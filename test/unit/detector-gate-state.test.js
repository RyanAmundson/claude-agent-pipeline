import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATES } from '../../api/index.js';

test('needs-detector-gate sits immediately after needs-code-review', () => {
  assert.ok(STATES.includes('needs-detector-gate'), 'needs-detector-gate missing');
  const cr = STATES.indexOf('needs-code-review');
  const dg = STATES.indexOf('needs-detector-gate');
  assert.equal(dg, cr + 1, `expected detector-gate right after code-review, got cr=${cr} dg=${dg}`);
});

test('detector-gate precedes the regression/feature gates and ready-for-human', () => {
  const dg = STATES.indexOf('needs-detector-gate');
  const rh = STATES.indexOf('ready-for-human');
  assert.ok(dg < rh, 'detector-gate must precede ready-for-human');
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root2 = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const schema = JSON.parse(readFileSync(join(root2, 'config.schema.json'), 'utf8'));

test('config schema declares detectors block and maxAutoFixDiffLines', () => {
  assert.ok(schema.properties.detectors, 'detectors property missing');
  assert.ok(schema.properties.detectors.properties.diffGate, 'detectors.diffGate missing');
  assert.ok(schema.properties.detectors.properties.fullSweepEveryNCycles, 'fullSweepEveryNCycles missing');
  assert.equal(schema.properties.maxAutoFixDiffLines.type, 'integer');
});
