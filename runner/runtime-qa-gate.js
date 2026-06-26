// The needs-runtime-qa fan-out gate. Mirrors detector-gate.js: reuses computeGate() and
// finalMessageOf(), fans out matched members against the running app, folds in per-member
// console errors, persists verdicts, and computes one severity gate.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { dispatch } from './dispatch.js';
import { computeGate, finalMessageOf } from './detector-gate.js';
import { extractVerdict } from './verdict.js';
import { matchMembers } from './runtime-qa-match.js';
import { MEMBERS } from './runtime-qa-members.js';

export const CONSOLE_FAIL_DEFAULT = ['uncaught', 'hydration'];

/**
 * Fold a member's captured console errors into its verdict as findings.
 * `failOn` kinds become `major` (→ veto); everything else becomes `minor`.
 * @param {{verdict:string, findings?:any[]}} verdict
 * @param {Array<{kind:string, text?:string}>} [consoleEvents]
 * @param {string[]} [failOn]
 */
export function foldConsoleFindings(verdict, consoleEvents = [], failOn = CONSOLE_FAIL_DEFAULT) {
  const findings = [...(verdict.findings || [])];
  for (const e of consoleEvents) {
    findings.push({
      severity: failOn.includes(e.kind) ? 'major' : 'minor',
      title: `console: ${e.kind}`,
      detail: e.text || '',
      source: 'console',
    });
  }
  return { ...verdict, findings };
}

/** Default console source: <target>/.pipeline/evidence/<pr>/runtime-qa/<member>/console.json (JSON array). */
export function consoleEventsOf(target, pr, memberId) {
  const p = join(target, '.pipeline', 'evidence', String(pr), 'runtime-qa', memberId, 'console.json');
  if (!existsSync(p)) return [];
  try { const j = JSON.parse(readFileSync(p, 'utf8')); return Array.isArray(j) ? j : []; }
  catch { return []; }
}

/**
 * Fan out matched runtime-QA members for a PR, persist verdicts, compute the gate.
 * @param {{target:string, pr:string|number, changedFiles:Array<{path:string}>,
 *          members?:any[], qaPrompt:(m:any)=>string, config?:any}} o
 * @param {{dispatch?:Function, finalMessageOf?:Function, consoleEventsOf?:Function}} [deps]
 */
export async function runRuntimeQaGate({ target, pr, changedFiles, members = MEMBERS, qaPrompt, config = {} }, deps = {}) {
  const dispatchFn = deps.dispatch || dispatch;
  const readFinal = deps.finalMessageOf || finalMessageOf;
  const readConsole = deps.consoleEventsOf || consoleEventsOf;
  const memberCfg = config.members || {};
  const consoleEnabled = config.consoleErrors?.enabled !== false;
  const failOn = config.consoleErrors?.failOn || CONSOLE_FAIL_DEFAULT;

  const active = matchMembers(members, changedFiles)
    .filter(m => memberCfg[m.id]?.enabled !== false);

  const reviewsDir = join(target, '.pipeline', 'reviews', String(pr));
  mkdirSync(reviewsDir, { recursive: true });

  const verdicts = await Promise.all(active.map(async (m) => {
    const h = dispatchFn({ agent: m.agent, prompt: qaPrompt(m), target, model: m.model });
    const run = await h.result;
    let verdict = run.status === 'completed'
      ? extractVerdict(readFinal(target, run.runId))
      : { verdict: 'veto', findings: [], reason: 'malformed-or-missing' }; // crash → fail-closed
    if (consoleEnabled) verdict = foldConsoleFindings(verdict, readConsole(target, pr, m.id), failOn);
    writeFileSync(join(reviewsDir, `runtime-qa-${m.id}.json`), JSON.stringify({ member: m.id, ...verdict }, null, 2));
    return verdict;
  }));

  const result = computeGate(verdicts);
  writeFileSync(join(reviewsDir, 'runtime-qa-gate.json'), JSON.stringify(result, null, 2));
  return result;
}
