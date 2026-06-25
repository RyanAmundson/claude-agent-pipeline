import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRunLine, resolveDone } from '../../../integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/cap.js';

test('run.start → running', () => {
  assert.deepEqual(parseRunLine(JSON.stringify({ type: 'run.start' })), { kind: 'running' });
});

test('run.update with activity → activity text', () => {
  assert.deepEqual(
    parseRunLine(JSON.stringify({ type: 'run.update', activity: 'editing file' })),
    { kind: 'activity', activity: 'editing file' }
  );
});

test('end with completed status → done ok:true', () => {
  assert.deepEqual(
    parseRunLine(JSON.stringify({ type: 'end', run: { status: 'completed', exitCode: 0 } })),
    { kind: 'done', ok: true }
  );
});

test('end with failed status → done ok:false', () => {
  assert.deepEqual(
    parseRunLine(JSON.stringify({ type: 'end', run: { status: 'failed', exitCode: 1 } })),
    { kind: 'done', ok: false }
  );
});

test('run.fail → done ok:false', () => {
  assert.deepEqual(parseRunLine(JSON.stringify({ type: 'run.fail' })), { kind: 'done', ok: false });
});

test('run.kill → done ok:false', () => {
  assert.deepEqual(parseRunLine(JSON.stringify({ type: 'run.kill' })), { kind: 'done', ok: false });
});

test('non-JSON / unknown → ignore', () => {
  assert.deepEqual(parseRunLine('not json'), { kind: 'ignore' });
  assert.deepEqual(parseRunLine(JSON.stringify({ type: 'whatever' })), { kind: 'ignore' });
});

test('resolveDone trusts a terminal event over the exit code', () => {
  assert.deepEqual(resolveDone(true, false, 0), { ok: false });   // run.fail then exit 0
  assert.deepEqual(resolveDone(true, true, 1), { ok: true });
  assert.deepEqual(resolveDone(false, false, 0), { ok: true });   // no terminal → exit code
  assert.deepEqual(resolveDone(false, false, 1), { ok: false });
});
