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
