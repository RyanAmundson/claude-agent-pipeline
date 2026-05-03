# Manual Test Plan

This is the test plan for validating the agent-pipeline plugin on a fresh project the plugin author is unfamiliar with. The goal is to catch bake-ins that survived the parameterization sweep.

## Goal

Run the pipeline end-to-end against a sample repo (greenfield or existing) and verify each phase works without project-specific assumptions leaking through.

## Test repo setup

Pick a repo. Greenfield is easier for the first run because the pipeline starts with no work and you control what you create.

Suggested setup:

1. New GitHub repo, single user, ~10 files of arbitrary code (could be a tiny CLI, a single React component, anything)
2. Either Linear access OR no Linear (filesystem backend)

## Phase 1: install and init

| Step | Expected | Notes |
|---|---|---|
| Install plugin in Claude Code | `/plugin install` succeeds | |
| `/pipeline-init` in test repo | Walks through prompts, no errors | Note any prompt that's confusing or hardcoded |
| `cat .pipeline/config.json` | Valid JSON matching schema | Should pass `jq -e .` |
| `gh label list` | All 27 labels exist | Pipeline + agent labels |
| `ls .pipeline/queue` (filesystem only) | All 11 state subdirs | |
| Re-run `/pipeline-init` | Idempotent — doesn't error on existing labels | |

## Phase 2: introduce findings

Plant deliberate violations to seed the pipeline:

1. Add a file with a hardcoded `sk-FAKE_TEST_KEY_FAKE_FAKE_FAKE_FAKE_FAKE` (security-detector should flag)
2. Add a file with a silent catch (`try { ... } catch {}` or `catch (e) { console.error(e) }`)
3. Add an unused exported function

Commit and push to main (the pipeline scans main).

## Phase 3: run one cycle

`/pipeline-start`. Watch the orchestrator's first cycle.

| Check | Expected |
|---|---|
| Orchestrator reads config | No errors, prints stage snapshot |
| Scanner runs | Finds 3 issues (or close — exact count depends on heuristic precision) |
| Findings reach the queue | Linear: issues created with `pipeline:needs-triage`. Filesystem: JSON files in `needs-triage/` |
| Orchestrator dispatches ticket-creator | Tickets appear with `pipeline:needs-review` |
| Ticket-reviewer runs | Tickets transition to `pipeline:needs-work` |
| Orchestrator dispatches worker | Worker creates a worktree under `.worktrees/`, opens a PR |
| PR has audit comment | `[agent:worker] Implemented ...` comment on the PR |
| PR has correct labels | `agent:worker`, `pipeline:needs-test-review` |

## Phase 4: review the PR

| Check | Expected |
|---|---|
| Tester reviews the PR | `[agent:tester]` comment on PR with verdict |
| Code-reviewer reviews | `[agent:code-reviewer]` comment on PR with verdict |
| Labels transition correctly | Eventually reaches `pipeline:ready-for-human` |
| Human reviewer (you) is requested | `gh pr view` shows you as reviewer |

## Phase 5: leave a comment

Leave a non-trivial comment on the PR like "Can you also handle the null case?"

| Check | Expected |
|---|---|
| Orchestrator detects unresolved comment | Next cycle, dispatches feedback-responder |
| Feedback-responder addresses | New commit, `[agent:feedback-responder] Addressed in <sha>` reply |
| Label transitions back through review | `needs-test-review` → `needs-code-review` → `ready-for-human` |

## Phase 6: merge and cleanup

Merge the PR.

| Check | Expected |
|---|---|
| Cleanup runs | Worktree removed, branch deleted, ticket marked done |
| Orchestrator next cycle | Pipeline shows the work as done; no zombie state |

## Phase 7: stress

Plant 5+ findings at once and watch the flex-worker / multi-dispatch behavior.

| Check | Expected |
|---|---|
| Multiple workers dispatched in parallel | Up to `maxAgentsPerCycle` running |
| No duplicate work | No two workers claiming the same ticket |
| Worktree cap respected | Cleanup runs if > `maxWorktrees` |

## Bake-ins to look for

Specifically watch for things that fail because they were project-specific:

- [ ] Any reference to `${REPO_SLUG}`, `${GH_USER}`, `<test-user>`, `<linear-team>`
- [ ] Any path containing `<your-repo-root>` — should be parameterized via `worktreeRoot`
- [ ] `npm run` commands that aren't covered by `config.verify`
- [ ] Glossary references that assume `docs/glossary.md` exists
- [ ] References to `docs/SYSTEMS.md`, `.claude/rules/*` (project-specific structure)
- [ ] Hardcoded port `3333` outside of `e2e.appPort`
- [ ] Any prompt that mentions specific feature folders (`features/agents/`, etc.)

## Self-audit cross-check

After 3+ cycles:

- [ ] `config.lessonsDir` should exist and contain at least one `.md` file (the orchestrator's self-audit should have written something)
- [ ] No agent prompt files were modified — only `.pipeline/lessons/*.md`

## Known limitations to confirm

- [ ] Filesystem backend works on macOS, Linux. Not tested on Windows (WSL should work).
- [ ] Linear backend requires the user to have Linear MCP connected.
- [ ] E2E agents are Playwright-specific; users with other E2E tools should disable them in config.

## After the test

Capture findings in `docs/TEST_RESULTS_v0.1.md`. Each finding becomes either:

- A bake-in to fix in v0.1.1
- A documentation gap to address in README
- A genuine feature gap to add to the v0.2 backlog
