import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverProjects } from '../../../integrations/streamdock/com.cap.streamdock.sdPlugin/plugin/cap.js';

test('discoverProjects finds dirs with .pipeline/config.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'cap-disc-'));
  try {
    mkdirSync(join(root, 'alpha', '.pipeline'), { recursive: true });
    writeFileSync(join(root, 'alpha', '.pipeline', 'config.json'), '{}');
    mkdirSync(join(root, 'beta'), { recursive: true });            // no pipeline
    const found = discoverProjects([root]);
    assert.deepEqual(found.map((p) => p.name), ['alpha']);
    assert.equal(found[0].path, join(root, 'alpha'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
