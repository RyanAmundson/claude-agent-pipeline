// test/unit/detector-gate.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeGate } from '../../runner/detector-gate.js';

test('all pass / only minor → ready-for-human', () => {
  const r = computeGate([
    { verdict: 'pass', findings: [] },
    { verdict: 'pass', findings: [{ severity: 'minor', title: 'm' }, { severity: 'nit', title: 'n' }] },
  ]);
  assert.equal(r.gate, 'pass');
  assert.equal(r.nextState, 'needs-detector-gate->advance');
  assert.equal(r.blocking.length, 0);
});

test('any major → veto → needs-feedback', () => {
  const r = computeGate([{ verdict: 'pass', findings: [{ severity: 'major', title: 'big' }] }]);
  assert.equal(r.gate, 'veto');
  assert.equal(r.label, 'needs-feedback');
  assert.equal(r.blocking.length, 1);
});

test('an explicit veto verdict with no findings still vetoes', () => {
  assert.equal(computeGate([{ verdict: 'veto', findings: [] }]).gate, 'veto');
});

test('a synthetic/malformed veto (fail-closed) vetoes', () => {
  assert.equal(computeGate([{ verdict: 'veto', findings: [], reason: 'malformed-or-missing' }]).gate, 'veto');
});

test('empty verdict set passes (no detector matched the diff)', () => {
  assert.equal(computeGate([]).gate, 'pass');
});
