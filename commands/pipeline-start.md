---
name: pipeline-start
description: Start the agent pipeline orchestrator on a self-paced loop.
---

# /pipeline-start

Launch the orchestrator. Equivalent to `/loop orchestrator` but with pre-flight checks.

## Pre-flight

1. **Verify config exists**: `.pipeline/config.json` must exist. If not, instruct the user to run `/pipeline-init` first.
2. **Validate config**: load the JSON, check it matches `config.schema.json`.
3. **Verify GitHub auth**: `gh auth status` must succeed for the configured `ghUser`.
4. **Verify backend**:
   - Linear: check that the `linear` MCP server is connected. If not, instruct the user to connect via `/mcp`.
   - Filesystem: check that `.pipeline/queue/` exists with all expected subdirectories. If not, run `mkdir -p` for them.
5. **Verify labels exist**: spot-check a few critical labels (`pipeline:needs-work`, `agent:worker`). If missing, suggest re-running `/pipeline-init`.
6. **Optional: warn on unclean state**: if there are stale worktrees or in-progress tickets older than 2 hours, mention them but don't block.

## Launch

If all pre-flight checks pass:

```
/loop orchestrator
```

The orchestrator self-paces — initial 270s, scaling to 1800s when idle.

## Stop

The user stops the loop with the standard Claude Code loop-cancel mechanism (or by killing the session).

## Output

```
Pipeline starting:
  Repo: owner/repo
  Backend: linear (team ENG)
  Verify: npm run type-check, npm run lint
  Active worktrees: 2

Pre-flight: ✓
Launching orchestrator (self-paced loop).
```
