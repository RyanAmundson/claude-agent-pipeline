// runner/detector-gate.js
// Diff-gate for the needs-detector-gate stage.
// computeGate() is the pure, deterministic decision Spec B reuses.
// runDetectorGate() fans out matched detectors in diff-mode and persists verdicts.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dispatch } from './dispatch.js';
import { matchDetectors } from './detector-match.js';
import { extractVerdict } from './verdict.js';
import { getRunEvents } from '../api/runs.js';

const BLOCKING = new Set(['blocker', 'major']);

/** Pure gate over a set of provider verdicts. @param {Array<{verdict,findings,reason?}>} verdicts */
export function computeGate(verdicts) {
  const blocking = [];
  let veto = false;
  for (const v of verdicts) {
    if (v.verdict === 'veto') veto = true;
    for (const f of v.findings || []) if (BLOCKING.has(f.severity)) { veto = true; blocking.push(f); }
  }
  return veto
    ? { gate: 'veto', label: 'needs-feedback', blocking }
    : { gate: 'pass', label: 'advance', nextState: 'needs-detector-gate->advance', blocking: [] };
}

/** Read a completed run's final assistant text from its events log. */
function finalMessageOf(target, runId) {
  const events = getRunEvents(target, runId); // array of normalized events
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'assistant') {
      const blocks = e.raw?.message?.content;
      if (Array.isArray(blocks)) {
        const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
        if (text.trim()) return text;
      }
    }
  }
  return '';
}

/**
 * Fan out matched diff-mode detectors for a PR, persist verdicts, compute the gate.
 * @param {{target:string, pr:string, changedFiles:Array<{path,content}>, registry:any[], diffPrompt:(d:any)=>string}} o
 */
export async function runDetectorGate({ target, pr, changedFiles, registry, diffPrompt }) {
  const matched = matchDetectors(registry, changedFiles, { mode: 'diff' });
  const reviewsDir = join(target, '.pipeline', 'reviews', String(pr));
  mkdirSync(reviewsDir, { recursive: true });

  const verdicts = await Promise.all(matched.map(async (d) => {
    const h = dispatch({ agent: `${d.id}-detector`, prompt: diffPrompt(d), target, model: d.model });
    const run = await h.result;
    const verdict = run.status === 'completed'
      ? extractVerdict(finalMessageOf(target, run.runId))
      : { verdict: 'veto', findings: [], reason: 'malformed-or-missing' }; // crash → fail-closed
    writeFileSync(join(reviewsDir, `detector-${d.id}.json`), JSON.stringify({ detector: d.id, ...verdict }, null, 2));
    return verdict;
  }));

  const result = computeGate(verdicts);
  writeFileSync(join(reviewsDir, 'detector-gate.json'), JSON.stringify(result, null, 2));
  return result;
}
