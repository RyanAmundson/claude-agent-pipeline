// test/unit/verdict.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractVerdict } from '../../runner/verdict.js';

test('extracts a fenced json verdict from a messy final message', () => {
  const msg = 'Here is my review.\n```json\n{ "verdict": "veto", "findings": [{"severity":"major","file":"a.ts","line":1,"title":"x","detail":"y"}] }\n```\nDone.';
  const v = extractVerdict(msg);
  assert.equal(v.verdict, 'veto');
  assert.equal(v.findings.length, 1);
});

test('missing or unparseable verdict fails closed (synthetic veto)', () => {
  assert.equal(extractVerdict('no json here').verdict, 'veto');
  assert.equal(extractVerdict('').verdict, 'veto');
  assert.equal(extractVerdict('```json\n{ not valid }\n```').verdict, 'veto');
  assert.match(extractVerdict('nothing').reason, /malformed-or-missing/);
});

test('a pass verdict with no findings parses cleanly', () => {
  const v = extractVerdict('```json\n{"verdict":"pass","findings":[]}\n```');
  assert.equal(v.verdict, 'pass');
  assert.deepEqual(v.findings, []);
});

test('synthetic veto returns a fresh findings array each call (no shared mutation)', () => {
  const a = extractVerdict('not json');
  const b = extractVerdict('also not json');
  a.findings.push({ injected: true });
  assert.equal(b.findings.length, 0, 'each synthetic veto must own its findings array');
  assert.notEqual(a.findings, b.findings);
});
