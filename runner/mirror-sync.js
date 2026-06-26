// Local mirror of the Linear backend in the filesystem-backend queue layout.
// Zero runtime deps (node:* only). Poll-driven (relay-free); Plan 2 reuses
// applyMirror() for webhook push.

const VALID_STATES = new Set([
  'needs-triage', 'needs-review', 'needs-work', 'in-progress',
  'needs-test-review', 'needs-code-review', 'needs-detector-gate',
  'needs-regression-check', 'needs-runtime-qa', 'needs-feature-validation',
  'needs-feedback', 'needs-conflict-resolution', 'ready-for-human', 'done',
  'needs-info', 'obsolete',
]);

export function stateLabelRe(namespace) {
  return new RegExp(`^${namespace}:(.+)$`);
}

/**
 * @param {any} issue Linear issue (MCP shape).
 * @param {{ namespace: string, now: string }} opts
 * @returns {{ ticket: object, state: string } | null}
 */
export function mapIssueToTicket(issue, opts) {
  const re = stateLabelRe(opts.namespace);
  const labels = (issue.labels?.nodes ?? []).map((l) => l.name);
  let state = null;
  for (const name of labels) {
    const m = re.exec(name);
    if (m && VALID_STATES.has(m[1])) { state = m[1]; break; }
  }
  if (!state) return null;
  const ticket = {
    id: issue.identifier,
    title: issue.title ?? '',
    description: issue.description ?? '',
    priority: issue.priority ?? 99,
    labels,
    claim: issue.assignee?.displayName ?? null,
    url: issue.url ?? null,
    raw: issue,
    _syncedAt: opts.now,
    _rev: issue.updatedAt ?? opts.now,
    _source: 'reconcile',
  };
  return { ticket, state };
}
