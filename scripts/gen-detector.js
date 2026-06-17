// Generates agents/detectors/<id>.md from detectors.registry.json + _template.md.
// Pure helpers (renderDetector, validateSync) are exported for tests; the CLI
// entry (run directly) writes files and updates manifest.json.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const TOKENS = ['id', 'title', 'glob', 'model', 'mode', 'severity', 'routesTo', 'detect', 'suggestedFix'];

export function renderDetector(template, entry) {
  let out = template;
  for (const t of TOKENS) {
    out = out.split('${' + t + '}').join(String(entry[t] ?? ''));
  }
  return out;
}

/** @returns {{missingFiles:string[], orphanFiles:string[]}} */
export function validateSync(registryIds, fileIds) {
  const reg = new Set(registryIds), files = new Set(fileIds);
  return {
    missingFiles: registryIds.filter(id => !files.has(id)),
    orphanFiles: fileIds.filter(id => !reg.has(id)),
  };
}

function detectorFileIds(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.md') && f !== '_template.md')
    .map(f => f.replace(/\.md$/, ''));
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const registry = JSON.parse(readFileSync(join(root, 'detectors.registry.json'), 'utf8'));
  const template = readFileSync(join(root, 'agents/detectors/_template.md'), 'utf8');
  const outDir = join(root, 'agents/detectors');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const ids = registry.detectors.map(d => d.id);
  for (const entry of registry.detectors) {
    writeFileSync(join(outDir, `${entry.id}.md`), renderDetector(template, entry));
  }
  const { orphanFiles } = validateSync(ids, detectorFileIds(outDir));
  if (orphanFiles.length) {
    console.error(`[gen-detector] orphan files with no registry entry: ${orphanFiles.join(', ')}`);
    process.exitCode = 1;
  }

  // Register detectors in manifest.json under agents (idempotent).
  const manifestPath = join(root, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.agents ||= {};
  for (const entry of registry.detectors) {
    manifest.agents[`${entry.id}-detector`] ||= { path: `agents/detectors/${entry.id}.md`, stage: 'detect' };
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`[gen-detector] wrote ${ids.length} detectors`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
