// test/unit/runtime-qa-agents.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MEMBERS } from '../../runner/runtime-qa-members.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

test('every member maps to an agent file that emits the JSON verdict contract', () => {
  for (const m of MEMBERS) {
    const file = join(root, 'agents', `${m.agent}.md`);
    assert.ok(existsSync(file), `missing agent file agents/${m.agent}.md`);
    const body = readFileSync(file, 'utf8');
    assert.match(body, /```json/, `${m.agent}.md must document the json verdict block`);
    assert.match(body, /"verdict"/, `${m.agent}.md must document the verdict field`);
  }
});

test('every non-data member agent is registered in the manifest quality stage with agent-browser', () => {
  for (const m of MEMBERS) {
    if (m.id === 'data') continue; // data-validator is pre-registered
    const entry = manifest.agents[m.agent];
    assert.ok(entry, `manifest missing ${m.agent}`);
    assert.equal(entry.stage, 'quality');
    assert.ok(entry.requires.includes('github') && entry.requires.includes('agent-browser'),
      `${m.agent} must require github + agent-browser`);
  }
});
