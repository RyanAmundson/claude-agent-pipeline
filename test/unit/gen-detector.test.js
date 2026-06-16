import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderDetector, validateSync } from '../../scripts/gen-detector.js';

const entry = {
  id: 'unjustified-any', title: 'Unjustified `any`', glob: 'src/**/*.{ts,tsx}',
  prefilterPattern: ':\\s*any\\b', model: 'haiku', mode: 'both', severity: 'major',
  routesTo: 'ticket-creator', detect: 'An any type with no justification comment nearby.',
  suggestedFix: 'Replace any with the real type.',
};
const template = [
  '---', 'name: ${id}-detector', 'model: ${model}', '---',
  '# ${title} Detector', 'mode ${mode} sev ${severity} glob ${glob} routes ${routesTo}',
  '${detect}', '${suggestedFix}',
].join('\n');

test('renderDetector substitutes every token and leaves none behind', () => {
  const out = renderDetector(template, entry);
  assert.ok(out.includes('name: unjustified-any-detector'));
  assert.ok(out.includes('model: haiku'));
  assert.ok(out.includes('# Unjustified `any` Detector'));
  assert.ok(out.includes('mode both sev major glob src/**/*.{ts,tsx} routes ticket-creator'));
  assert.ok(out.includes('An any type with no justification comment nearby.'));
  assert.ok(!/\$\{[a-zA-Z]+\}/.test(out), 'no unsubstituted ${...} tokens may remain');
});

test('validateSync flags a registry id with no generated file', () => {
  const res = validateSync(['unjustified-any', 'ts-suppression'], ['unjustified-any']);
  assert.deepEqual(res.missingFiles, ['ts-suppression']);
  assert.deepEqual(res.orphanFiles, []);
});

test('validateSync flags a generated file with no registry entry', () => {
  const res = validateSync(['unjustified-any'], ['unjustified-any', 'stale-detector']);
  assert.deepEqual(res.missingFiles, []);
  assert.deepEqual(res.orphanFiles, ['stale-detector']);
});
