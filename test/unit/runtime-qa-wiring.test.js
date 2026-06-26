// test/unit/runtime-qa-wiring.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const orch = readFileSync(join(root, 'agents', 'orchestrator.md'), 'utf8');
const pipe = readFileSync(join(root, 'agents', 'PIPELINE.md'), 'utf8');
const init = readFileSync(join(root, 'commands', 'pipeline-init.md'), 'utf8');

test('orchestrator dispatches the runtime-qa gate runner', () => {
  assert.match(orch, /needs-runtime-qa/);
  assert.match(orch, /runner\/runtime-qa-gate\.js/);
});

test('PIPELINE documents the needs-runtime-qa state', () => {
  assert.match(pipe, /needs-runtime-qa/);
});

test('pipeline-init creates the state label + the *-validator provenance labels', () => {
  assert.match(init, /needs-runtime-qa/);
  assert.match(init, /interaction-validator/);
  assert.match(init, /perf-validator/);
});
