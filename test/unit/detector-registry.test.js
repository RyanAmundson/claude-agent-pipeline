// test/unit/detector-registry.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const registry = JSON.parse(readFileSync(join(root, 'detectors.registry.json'), 'utf8'));

const MODES = new Set(['sweep', 'diff', 'both']);
const SEVERITIES = new Set(['blocker', 'major', 'minor', 'nit']);
const MODELS = new Set(['haiku', 'sonnet', 'opus']);
const ROUTES = new Set(['ticket-creator', 'dead-code-remover', 'glossary-maintainer']);

test('registry is a non-empty array with unique ids', () => {
  assert.ok(Array.isArray(registry.detectors), 'registry.detectors must be an array');
  assert.ok(registry.detectors.length >= 14, 'expected at least 14 detectors');
  const ids = registry.detectors.map(d => d.id);
  assert.equal(new Set(ids).size, ids.length, 'detector ids must be unique');
});

test('every detector entry has valid required fields', () => {
  for (const d of registry.detectors) {
    assert.match(d.id, /^[a-z0-9-]+$/, `bad id: ${d.id}`);
    assert.ok(d.title && typeof d.title === 'string', `${d.id}: title required`);
    assert.ok(d.glob && typeof d.glob === 'string', `${d.id}: glob required`);
    assert.ok(d.prefilterPattern && typeof d.prefilterPattern === 'string', `${d.id}: prefilterPattern required`);
    assert.doesNotThrow(() => new RegExp(d.prefilterPattern), `${d.id}: prefilterPattern must be valid regex`);
    assert.ok(MODELS.has(d.model), `${d.id}: bad model ${d.model}`);
    assert.ok(MODES.has(d.mode), `${d.id}: bad mode ${d.mode}`);
    assert.ok(SEVERITIES.has(d.severity), `${d.id}: bad severity ${d.severity}`);
    assert.ok(ROUTES.has(d.routesTo), `${d.id}: bad routesTo ${d.routesTo}`);
    assert.ok(d.detect && d.detect.length > 20, `${d.id}: detect description required`);
    assert.ok(d.suggestedFix && d.suggestedFix.length > 10, `${d.id}: suggestedFix required`);
  }
});
