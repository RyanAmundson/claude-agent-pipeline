// test/unit/runtime-qa-trim.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rt = readFileSync(join(root, 'agents', 'regression-tester.md'), 'utf8');
const fv = readFileSync(join(root, 'agents', 'feature-validator.md'), 'utf8');

test('regression-tester no longer owns visual adjacency and hands off to runtime-qa', () => {
  assert.doesNotMatch(rt, /Visual adjacency check/i, 'visual-adjacency section should be removed');
  assert.match(rt, /needs-runtime-qa/, 'regression-tester PASS should target needs-runtime-qa');
});

test('feature-validator references the upstream runtime-QA gate (acceptance-only scope)', () => {
  assert.match(fv, /runtime-QA gate/i);
});
