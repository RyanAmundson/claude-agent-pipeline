# Agent Pipeline

A state-machine pipeline where each agent watches for a specific state, does its work, and hands off to the next stage by updating labels (or moving files, in the filesystem backend).

## Pipeline Flow

```
Scanner → Ticket Creator → Ticket Reviewer → Worker → Tester → Code Reviewer → Feedback Responder
                                                                                       ↓
                                                                               ready-for-human
                                                                                       ↓
                                                                               Branch Updater (merge main, push)
                                                                                       ↓
                                                                                Human merges
                                                                                       ↓
                                                                                  Cleanup
```

## Pipeline States

Each state is represented by a GitHub PR label, a Linear issue label, or a queue subdirectory (filesystem backend). An agent picks up items in its input state and transitions them to its output state.

The label namespace is configurable — defaults below assume `labelNamespace = "pipeline"`.

| State Label | Meaning | Owned By |
|---|---|---|
| `pipeline:needs-triage` | Quality issue found, needs a ticket | ticket-creator |
| `pipeline:needs-review` | Ticket created, needs quality/formatting review | ticket-reviewer |
| `pipeline:needs-work` | Ticket is actionable, needs implementation | worker |
| `pipeline:in-progress` | Worker is actively implementing | worker |
| `pipeline:needs-test-review` | PR open, needs test coverage review | tester |
| `pipeline:needs-code-review` | Tests reviewed, needs code quality review | code-reviewer |
| `pipeline:needs-feedback` | Review feedback needs addressing | feedback-responder |
| `pipeline:ready-for-human` | All automated checks pass, ready for human review | (terminal) |
| `needs-info` | Ticket lacks detail, parked until creator updates | ticket-reviewer |

## Provenance Labels

Each agent stamps its work with a provenance label so you can see who did what. Default namespace `agent`.

| Label | Agent |
|---|---|
| `agent:scanner` | Scanner found this issue |
| `agent:ticket-creator` | Ticket creator filed this ticket |
| `agent:ticket-reviewer` | Ticket reviewer validated and formatted this ticket |
| `agent:worker` | Worker implemented this |
| `agent:tester` | Tester reviewed tests |
| `agent:code-reviewer` | Code reviewer reviewed code |
| `agent:feedback-responder` | Feedback responder addressed comments |
| `agent:flex-worker` | Flex worker filled in (note which role) |
| `agent:orchestrator` | Orchestrator dispatched flex workers for bottleneck |
| `agent:branch-updater` | Branch updater synced branch with main |
| `agent:cleanup` | Cleanup agent removed worktree/branch/labels |

## Scope

Read from `.pipeline/config.json`:

- **Repo**: `config.repo` only — no other repositories
- **PRs**: Only PRs authored by `config.ghUser` — skip Dependabot, bots, contributors
- **Linear**: `config.linear.teamId` only (when backend is Linear)

## Global Rule: Human Comments Override Pipeline State

All agents must check for unresolved comments from `config.humanReviewer` (or `config.ghUser` if not separately configured) before acting on any PR. A comment is "unresolved" if there is no `[agent:feedback-responder] Addressed` reply after it.

Check all three comment sources: issue comments, review comments, and review bodies.

- If a PR has unresolved human comments → **only the feedback-responder may act on it**
- Other agents (tester, code-reviewer, flex-worker) must re-label the PR to `pipeline:needs-feedback` and skip it
- This prevents agents from burying human feedback under automated comments

## Global Rule: Blocked PRs Are Skipped

PRs with a `blocked-by:#NNN` label are waiting for another PR to merge first. All pipeline agents must skip blocked PRs until the blocking PR is merged and the `blocked-by` label is removed. The cleanup agent removes `blocked-by` labels when the blocking PR is merged.

## Global Rule: Merged PRs Are Done

Only the human reviewer merges PRs. Once a PR is merged:

- **No agent should act on it** — no code review, no test review, no feedback
- The cleanup agent handles post-merge work (removing worktrees, branches, labels)
- If an issue was missed, the scanner will catch it on the next cycle against main

## Global Rule: Self-Healing

The pipeline assumes external changes can happen at any time (labels removed, branches deleted, tickets updated, PRs merged manually). The orchestrator detects anomalies every cycle and auto-recovers:

- **Missing labels** → re-infer and re-apply from agent comment history
- **Deleted branches** → flag the PR for attention
- **Stuck PRs** (same state > 2 hours) → re-dispatch the appropriate agent
- **Cross-system drift** (PR merged but ticket still In Progress) → sync automatically
- **Pre-existing test failures** → tracked separately, don't block PRs

No anomaly should require manual intervention. If the orchestrator can't fix it, it reports it clearly.

## Global Rule: Continuous Improvement

**Every time the human reviewer manually flags a pipeline issue, that's a system failure.** The pipeline must learn from it:

1. **Analyze**: What class of issue was this? Why didn't the pipeline catch it?
2. **Fix**: Update the agent definition or orchestrator rule to detect and handle this automatically
3. **Verify**: The fix must be compounding — it prevents the entire class of issues, not just the specific instance
4. **Log**: Record the lesson in `config.lessonsDir` so it persists across sessions

The human's manual interventions are the pipeline's training signal. The goal is zero manual interventions over time.

## Agent Configuration

### Single loop

| Agent | Pacing | Purpose |
|---|---|---|
| orchestrator | 270s when active, up to 1800s when idle | The only loop — dispatches all other agents on-demand |

### On-demand (dispatched by orchestrator)

| Agent | Dispatched when |
|---|---|
| ticket-creator | `pipeline:needs-triage` items exist |
| ticket-reviewer | `pipeline:needs-review` items exist |
| worker | `pipeline:needs-work` items exist |
| tester | `pipeline:needs-test-review` items exist |
| code-reviewer | `pipeline:needs-code-review` items exist |
| feedback-responder | `pipeline:needs-feedback` items or unresolved human comments exist |
| branch-updater | `pipeline:ready-for-human` PRs that are behind main |
| scanner | No scan in the last 30 minutes |
| cleanup | Merged PRs, stale worktrees, or label mismatches exist |
| flex-worker | Any stage is bottlenecked (3+ items) |

## Starting the Pipeline

Run `/pipeline start` to launch the orchestrator. One command: `/loop orchestrator`.

## Worktree Rules

- **Main worktree** stays on `main` — reserved for the human's direct work
- **All agent work** must use isolated worktrees — never check out a branch on the main worktree
- Agents must use `isolation: "worktree"` or create worktrees explicitly via `git worktree add`
- Worktree root is `config.worktreeRoot` (default `.worktrees`)

## Backends

### Linear backend

When `config.backend = "linear"`:

- Tickets live in Linear under `config.linear.teamId`
- State transitions update Linear labels (`pipeline:*` labels on the issue)
- Agents query Linear via `mcp__linear__*` tools
- No local locking concerns — Linear handles concurrent state

### Filesystem backend

When `config.backend = "filesystem"`:

- Tickets live as JSON files: `.pipeline/queue/<state>/<id>.json`
- State transitions are filesystem moves: `mv .pipeline/queue/needs-work/X.json .pipeline/queue/in-progress/X.json`
- `mv` within the same filesystem is atomic — first agent wins, second gets ENOENT
- For read-modify-write operations on a single ticket file, wrap with `flock(1)`:
  ```bash
  flock .pipeline/queue/.lock -c 'jq ".status = \"done\"" X.json > X.json.new && mv X.json.new X.json'
  ```
- Helper scripts in `queue/` provide `claim`, `transition`, `list` operations
