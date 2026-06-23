import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState, setActiveProject } from '../../../integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/state.js';

test('state round-trips active project via CAP_STATE_DIR override', () => {
  process.env.CAP_STATE_DIR = mkdtempSync(join(tmpdir(), 'cap-state-'));
  assert.equal(readState().activeProject, null);
  setActiveProject('/Users/ryan/Code/TRQ_Berry');
  assert.equal(readState().activeProject, '/Users/ryan/Code/TRQ_Berry');
  delete process.env.CAP_STATE_DIR;
});
