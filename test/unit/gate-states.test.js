import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATES } from '../../api/index.js';
import { DISPATCH_STATE } from '../../api/cycles.js';

test('STATES includes the two gate states in order after needs-code-review', () => {
  assert.ok(STATES.includes('needs-regression-check'), 'needs-regression-check missing');
  assert.ok(STATES.includes('needs-feature-validation'), 'needs-feature-validation missing');
  const cr = STATES.indexOf('needs-code-review');
  const rc = STATES.indexOf('needs-regression-check');
  const fv = STATES.indexOf('needs-feature-validation');
  const rh = STATES.indexOf('ready-for-human');
  assert.ok(cr < rc && rc < fv && fv < rh,
    `expected order code-review < regression < feature-validation < ready, got ${cr},${rc},${fv},${rh}`);
});

test('DISPATCH_STATE maps the two new gate agents to their states', () => {
  assert.equal(DISPATCH_STATE['regression-tester'], 'needs-regression-check');
  assert.equal(DISPATCH_STATE['feature-validator'], 'needs-feature-validation');
});
