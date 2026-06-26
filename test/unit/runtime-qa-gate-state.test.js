// test/unit/runtime-qa-gate-state.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { STATES } from '../../api/index.js';

test('needs-runtime-qa sits between regression-check and feature-validation', () => {
  assert.ok(STATES.includes('needs-runtime-qa'), 'needs-runtime-qa missing');
  const rc = STATES.indexOf('needs-regression-check');
  const rq = STATES.indexOf('needs-runtime-qa');
  const fv = STATES.indexOf('needs-feature-validation');
  assert.equal(rq, rc + 1, `expected runtime-qa right after regression-check (rc=${rc} rq=${rq})`);
  assert.equal(fv, rq + 1, `expected feature-validation right after runtime-qa (rq=${rq} fv=${fv})`);
});

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const schema = JSON.parse(readFileSync(join(root, 'config.schema.json'), 'utf8'));

test('config schema declares runtimeQa with enabled, members, consoleErrors', () => {
  const rq = schema.properties.runtimeQa;
  assert.ok(rq, 'runtimeQa property missing');
  assert.equal(rq.properties.enabled.type, 'boolean');
  assert.ok(rq.properties.members.properties.interaction, 'members.interaction missing');
  assert.ok(rq.properties.members.properties.data, 'members.data missing');
  assert.ok(rq.properties.consoleErrors.properties.failOn, 'consoleErrors.failOn missing');
});
