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
