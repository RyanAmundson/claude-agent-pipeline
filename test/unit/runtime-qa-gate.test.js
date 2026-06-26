import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldConsoleFindings, CONSOLE_FAIL_DEFAULT } from '../../runner/runtime-qa-gate.js';

test('an uncaught console event folds in as a major finding', () => {
  const out = foldConsoleFindings({ verdict: 'pass', findings: [] }, [{ kind: 'uncaught', text: 'boom' }]);
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0].severity, 'major');
  assert.equal(out.findings[0].source, 'console');
});

test('a non-failOn console kind folds in as a minor finding and preserves existing findings', () => {
  const out = foldConsoleFindings(
    { verdict: 'pass', findings: [{ severity: 'nit', title: 'pre' }] },
    [{ kind: 'react-warning', text: 'key prop' }],
  );
  assert.equal(out.findings.length, 2);
  assert.equal(out.findings.find(f => f.source === 'console').severity, 'minor');
});

test('CONSOLE_FAIL_DEFAULT covers uncaught + hydration', () => {
  assert.deepEqual(CONSOLE_FAIL_DEFAULT, ['uncaught', 'hydration']);
});
