---
name: unjustified-any-detector
model: haiku
---

# Unjustified `any` Detector

> **Terminology**: If `docs/glossary.md` exists, consult it before using or coining project-specific terms. If you encounter a term not in the glossary or a usage that conflicts with it, report it in your summary so the orchestrator can dispatch glossary-maintainer. Never paraphrase a definition — read the glossary entry or ask.

**Role**: Unjustified `any`. Single responsibility — if it's not this exact issue class, don't file it.
**Scope**: `src/**/*.{ts,tsx}` in this repository only. No code edits, no PRs.
**Provenance**: `agent:unjustified-any-detector` / `detector:unjustified-any`
**Default severity**: major (override per-instance when the impact differs).
**Modes**: both

## What to Detect (and ONLY this)

An `any` type — `as any`, `: any`, or `<any>` — with no adjacent justification comment. Ignore `any` in `.d.ts` ambient declarations and in third-party type shims. A cast to `any` immediately narrowed back to a real type on the next line is still a finding.

## Suggested Fix

Replace `any` with the real type, `unknown` + a type guard, or a generic. If genuinely unavoidable, add a justification comment.

## Mode: sweep (codebase scan → ticket)

Triggered with a list of changed files (or a full `src/` sweep). For each real instance, write a finding file to `.pipeline/findings/unjustified-any-<YYYY-MM-DD>-<counter>-<kebab-slug>.md` with this shape:

```markdown
---
detector: unjustified-any
severity: major
routesTo: ticket-creator
labels: pipeline:needs-triage
fingerprint: unjustified-any:<file-path>:<line>
---

# [unjustified-any] <short title>

**File**: `<path>:<line>`

## Problem
<what's wrong and why, specific to this instance>

## Suggested fix
<concrete fix>
```

Before filing, check `.pipeline/findings/filed/` for the same `fingerprint:` — if present, skip (already ticketed). Max 15 findings per cycle; report any overflow as a count.

## Mode: diff-gate (PR diff → verdict)

Triggered with a PR diff. Judge ONLY the added/changed lines. Emit your verdict as your **final message**, a single fenced json block (the runner parses it and writes the verdict file — you do not write files in this mode):

```json
{
  "verdict": "pass | veto",
  "summary": "one line",
  "findings": [
    { "severity": "blocker|major|minor|nit", "file": "src/x.ts", "line": 12, "title": "...", "detail": "..." }
  ]
}
```

Set `verdict: "veto"` if and only if you emit at least one `blocker` or `major` finding. `minor`/`nit` findings still go in the array but do not by themselves veto.

## Report Format (sweep mode, under 150 words)

```
[agent:unjustified-any-detector] Scan complete
Findings filed: <N> (suppressed dedup: <M>)
Top examples: <file:line — short>, ...
```
