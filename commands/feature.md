---
name: feature
description: File a new feature epic from a rough intent; the pipeline specs, designs, decomposes, builds, and assembles it.
---

# /feature

Start the **feature pipeline** from a one-line intent. Files a new epic in `feature:needs-spec`; the orchestrator then drives it autonomously (spec → design → decompose → build children → integrate → accept) up to a single human gate on the assembled feature.

Usage: `/feature <rough intent>` — e.g. `/feature dark mode for the dashboard`.

## Pre-flight

1. **Verify config exists**: `.pipeline/config.json` must exist. If not, instruct the user to run `/pipeline-init` first.
2. **Verify the orchestrator is (or will be) running**: the epic only advances past `needs-spec` while the orchestrator loop is active. If it isn't running, remind the user to `/pipeline-start` after filing.

## File the epic

Run the entry command with the user's intent:

```
agent-pipeline feature "<rough intent>"
```

This mints the next `EPIC-<id>`, writes it to `feature:needs-spec` (filesystem: `.pipeline/epics/needs-spec/EPIC-<id>.json`), and records the intent. No spec, design, or children exist yet — the pipeline produces those.

## Output

```
Created EPIC-007 in feature:needs-spec
  <rough intent>
  The orchestrator will dispatch feature-spec-writer on its next cycle.
```

The feature then flows autonomously; watch it in the dashboard's **features** tab (`agent-pipeline ui`). The only human gate is the final epic PR (`feature/EPIC-<id>` → main) when the feature reaches `feature:ready-for-human`.
