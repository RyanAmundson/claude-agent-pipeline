// runner/verdict.js
// Extract a strict JSON verdict from an agent's final message. Fail-closed:
// anything missing/unparseable becomes a synthetic veto.

const SYNTHETIC_VETO = { verdict: 'veto', summary: 'malformed or missing verdict', findings: [], reason: 'malformed-or-missing' };

/** @param {string} finalMessage @returns {{verdict:'pass'|'veto', summary?:string, findings:any[], reason?:string}} */
export function extractVerdict(finalMessage) {
  if (!finalMessage || typeof finalMessage !== 'string') return { ...SYNTHETIC_VETO, findings: [] };
  const block = finalMessage.match(/```json\s*([\s\S]*?)```/i);
  const raw = block ? block[1] : finalMessage;
  let parsed;
  try { parsed = JSON.parse(raw.trim()); }
  catch { return { ...SYNTHETIC_VETO, findings: [] }; }
  if (!parsed || (parsed.verdict !== 'pass' && parsed.verdict !== 'veto')) return { ...SYNTHETIC_VETO, findings: [] };
  return { verdict: parsed.verdict, summary: parsed.summary || '', findings: Array.isArray(parsed.findings) ? parsed.findings : [] };
}
