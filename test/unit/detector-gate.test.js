// test/unit/detector-gate.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeGate, finalMessageOf, runDetectorGate } from '../../runner/detector-gate.js';

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

test('finalMessageOf reads the last assistant text from a real run events log', () => {
  const target = mkdtempSync(join(tmpdir(), 'cap-gate-final-'));
  try {
    const runId = '20260101000000-abcd1234';
    const logsDir = join(target, '.pipeline', 'runs', 'logs');
    mkdirSync(logsDir, { recursive: true });
    const events = [
      { type: 'system', raw: { type: 'system' } },
      { type: 'assistant', raw: { type: 'assistant', message: { content: [{ type: 'text', text: '```json\n{"verdict":"pass","findings":[]}\n```' }] } } },
    ];
    writeFileSync(join(logsDir, `${runId}.events.jsonl`), events.map(e => JSON.stringify(e)).join('\n') + '\n');
    // Exercises the real getRunEvents({ target }, runId) read — a bare-string call would throw here.
    const msg = finalMessageOf(target, runId);
    assert.match(msg, /"verdict":"pass"/);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('runDetectorGate persists per-detector verdicts, fails closed on a crashed run, writes the gate', async () => {
  const target = mkdtempSync(join(tmpdir(), 'cap-gate-fanout-'));
  try {
    const registry = [
      { id: 'ok-det', glob: 'src/**/*.ts', prefilterPattern: 'any', mode: 'diff', model: 'haiku' },
      { id: 'crash-det', glob: 'src/**/*.ts', prefilterPattern: 'any', mode: 'diff', model: 'haiku' },
    ];
    const changedFiles = [{ path: 'src/a.ts', content: 'const x: any = 1' }];
    // ok-det completes cleanly; crash-det exits non-zero (status !== 'completed').
    const fakeDispatch = ({ agent }) => {
      const runId = `run-${agent}`;
      const status = agent === 'ok-det-detector' ? 'completed' : 'failed';
      return { runId, result: Promise.resolve({ status, runId }) };
    };
    const fakeFinal = (_t, runId) => runId === 'run-ok-det-detector'
      ? '```json\n{"verdict":"pass","findings":[]}\n```'
      : '';
    const result = await runDetectorGate(
      { target, pr: '7', changedFiles, registry, diffPrompt: () => 'review this diff' },
      { dispatch: fakeDispatch, finalMessageOf: fakeFinal },
    );

    // crash-det fails closed → veto, so the gate vetoes.
    assert.equal(result.gate, 'veto');

    const reviewsDir = join(target, '.pipeline', 'reviews', '7');
    const ok = JSON.parse(readFileSync(join(reviewsDir, 'detector-ok-det.json'), 'utf8'));
    assert.equal(ok.detector, 'ok-det');
    assert.equal(ok.verdict, 'pass');

    const crash = JSON.parse(readFileSync(join(reviewsDir, 'detector-crash-det.json'), 'utf8'));
    assert.equal(crash.detector, 'crash-det');
    assert.equal(crash.verdict, 'veto');
    assert.equal(crash.reason, 'malformed-or-missing');

    const gate = JSON.parse(readFileSync(join(reviewsDir, 'detector-gate.json'), 'utf8'));
    assert.equal(gate.gate, 'veto');
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});
