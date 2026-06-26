import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldConsoleFindings, CONSOLE_FAIL_DEFAULT, runRuntimeQaGate } from '../../runner/runtime-qa-gate.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

test('runRuntimeQaGate persists per-member verdicts, fails closed on crash, folds console, writes the gate', async () => {
  const target = mkdtempSync(join(tmpdir(), 'cap-rtqa-'));
  try {
    const members = [
      { id: 'interaction', agent: 'interaction-validator', globs: ['src/**/*.tsx'] },
      { id: 'visual',      agent: 'visual-validator',      globs: ['src/**/*.tsx'] },
      { id: 'data',        agent: 'data-validator',        always: true },
    ];
    const changedFiles = [{ path: 'src/features/x/[components]/Foo/Foo.tsx' }];

    // interaction completes clean; visual crashes (status !== 'completed'); data completes clean.
    const fakeDispatch = ({ agent }) => {
      const runId = `run-${agent}`;
      const status = agent === 'visual-validator' ? 'failed' : 'completed';
      return { runId, result: Promise.resolve({ status, runId }) };
    };
    const fakeFinal = (_t, runId) => runId === 'run-visual-validator'
      ? ''
      : '```json\n{"verdict":"pass","findings":[]}\n```';
    // interaction's browser logged an uncaught error → folds in as major → veto.
    const fakeConsole = (_t, _pr, memberId) => memberId === 'interaction'
      ? [{ kind: 'uncaught', text: 'TypeError x' }]
      : [];

    const result = await runRuntimeQaGate(
      { target, pr: '9', changedFiles, members, qaPrompt: () => 'validate the running app' },
      { dispatch: fakeDispatch, finalMessageOf: fakeFinal, consoleEventsOf: fakeConsole },
    );

    assert.equal(result.gate, 'veto'); // crash veto + folded console major

    const dir = join(target, '.pipeline', 'reviews', '9');
    const inter = JSON.parse(readFileSync(join(dir, 'runtime-qa-interaction.json'), 'utf8'));
    assert.equal(inter.member, 'interaction');
    assert.equal(inter.findings.find(f => f.source === 'console').severity, 'major');

    const vis = JSON.parse(readFileSync(join(dir, 'runtime-qa-visual.json'), 'utf8'));
    assert.equal(vis.verdict, 'veto');
    assert.equal(vis.reason, 'malformed-or-missing');

    const data = JSON.parse(readFileSync(join(dir, 'runtime-qa-data.json'), 'utf8'));
    assert.equal(data.member, 'data'); // dispatched via agent 'data-validator'

    const gate = JSON.parse(readFileSync(join(dir, 'runtime-qa-gate.json'), 'utf8'));
    assert.equal(gate.gate, 'veto');
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('empty active set (data disabled, util-only PR) passes', async () => {
  const target = mkdtempSync(join(tmpdir(), 'cap-rtqa-empty-'));
  try {
    const members = [{ id: 'data', agent: 'data-validator', always: true }];
    const result = await runRuntimeQaGate(
      { target, pr: '10', changedFiles: [{ path: 'README.md' }], members,
        qaPrompt: () => 'x', config: { members: { data: { enabled: false } } } },
      { dispatch: () => { throw new Error('should not dispatch'); } },
    );
    assert.equal(result.gate, 'pass');
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});
