---
paths:
  - ".claude/agents/**"
---

# Agent Work Protocol

Every agent that can be dispatched by the flex-worker (or chained from another agent) must include a `## Work Protocol` section with two subsections: `### Identify` and `### Handoff`.

This protocol enables:
- The **flex-worker** to query any agent's backlog uniformly
- Agents to **chain** to each other with a standard contract
- Work items to flow through a **consistent pipeline**

---

## Read the mirror, confirm-live before writing (Linear backend)

When config.backend = "linear", the local .pipeline/queue/ is a READ MIRROR of
Linear, refreshed each orchestrator cycle. For DISCOVERY and CONTEXT (what tickets
exist, their state, labels, claim), READ THE MIRROR via the queue helpers / read
API — do NOT query Linear live. This is what eliminates redundant empty queries.

Before any STATE CHANGE (claim, transition/label change, comment that gates a
handoff), CONFIRM-LIVE: re-fetch just that one issue from Linear, verify it still
holds the state you read from the mirror, then write live to Linear. Never treat
the mirror as authority for a decision to mutate. The mirror self-heals from your
write on the next cycle — do not hand-edit mirror files.

Exception: a dedup/freshness guard that gates a *create* (searching Linear to avoid making a duplicate) MUST read Linear live — the mirror can lag a full cycle, and a missed duplicate is the failure being prevented.

---

## Process Management (CRITICAL)

Orphaned test processes are the #1 cause of RAM exhaustion on the development machine. All agents must follow these rules:

1. **Feature specialists must NOT run tests.** Verification stops at `npm run type-check` and `npm run lint`. Test execution is handled by the dedicated test agents (`e2e-test-runner`) or by the owner manually.
2. **Never start a dev server.** If port 3333 is not listening, report the blocker and stop. Do NOT run `npm run dev &` — backgrounded dev servers become orphaned.
3. **Never use watch mode.** Do not run `npm run test:watch`, `vitest --watch`, or any command that keeps a process alive waiting for changes.
4. **Never use interactive/UI modes.** Do not run `npm run e2e:ui`, `npm run test:ui`, or `npx playwright test --ui` — these start long-lived servers.
5. **E2E test agents** that run Playwright must verify no orphaned browser processes remain after execution completes.

---

## Scope and Identity

### Scope

All agents operate on the **${REPO_NAME}** codebase only. Work items from other repos (other repos in your monorepo) are out of scope and should be skipped.

### Shared Account

All agents operate under a single GitHub and Linear account:

- **GitHub**: the human owner (`the human owner`)
- **Linear**: the human owner

Agents do **not** have their own accounts. Every action — commits, PR comments, Linear status updates — appears as the owner. This means agents **must identify themselves** in every externally visible action so it's clear which agent produced the work.

### Agent Identity Tag

Every comment, commit, or status update an agent posts must include an identity tag. Format:

```
[agent:{agent-name}]
```

**In GitHub PR comments:**
```markdown
[agent:tester] — Found 2 test issues in this PR:
...
```

**In commit messages:**
```
fix: add ErrorBoundary to dashboard page

[agent:dashboard-specialist]
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

**In Linear issue comments** (when updating status or leaving notes):
```
[agent:flex-worker] Claimed this issue. Routing to agents-feature-owner.
```

**In GitHub PR claim comments:**
```
[agent:tester] Claiming for test review
```

This tag goes at the **start** of the comment body (not buried at the end). It must be on its own line or at the beginning of the first line.

### Why This Matters

Without identity tags:
- You can't tell which agent produced a comment or commit
- You can't debug which agent misbehaved
- You can't tell agent activity apart from the owner's manual work
- Two agents claiming the same item can't tell who claimed first

---

## Protocol Sections

### `### Claim`

Optional section for agents that run alongside other instances and need to prevent double-picking. If present, the agent must execute the claim step **before starting work**. If the claim fails (item already claimed), the agent abandons that item and moves to the next.

The standard claim mechanism:
- **Linear issues**: Update status to "In Progress" via `mcp__linear__save_issue`
- **GitHub PRs**: Post a short comment indicating the item is claimed

Agents that always run as singletons (e.g., a dedicated `tester` instance) don't need a claim step — their `### Identify` filters already skip assigned/in-progress items. The claim step matters when **multiple agents with overlapping scope** (like flex workers) run concurrently.

### Stale Claims

A claim can become stale if a cycle crashes or times out mid-work. To prevent items from being permanently stuck:

- A **Linear claim** is stale if the issue has been "In Progress" for more than **2 hours** with no commits or comments from an agent in that window.
- A **GitHub claim comment** is stale if it was posted more than **1 hour** ago and no subsequent `[agent:*]` comment or commit appeared on the PR.

When an agent encounters a stale claim during its scan:
1. Post a comment: `[agent:{name}] Previous claim appears stale (no activity for >1h). Re-claiming.`
2. Proceed with the work as normal.

This prevents crashed cycles from permanently blocking items while still giving active agents enough time to finish.

### `### Identify`

Describes how the agent finds work. Must include:

| Field | Required | Description |
|-------|----------|-------------|
| `linear` | if applicable | Linear query parameters: state, labels, keywords, team |
| `github` | if applicable | GitHub CLI queries for PRs or issues |
| `filesystem` | if applicable | Glob patterns or commands to detect work in the repo |
| `filter` | yes | Criteria for excluding items (assigned, already in progress, etc.) |
| `score` | yes | How to rank/prioritize items when multiple exist |

Example:
```markdown
### Identify

- **Linear**: Issues in team CER with state Todo or Backlog containing keywords: dashboard, widget, chart, carousel, stats, metrics, report, visualization
- **GitHub**: Open PRs with labels matching `dashboard`; open issues mentioning dashboard components
- **Filesystem**: Changed files under `src/features/dashboard/` not covered by tests
- **Filter**: Skip items assigned to someone. Skip items in "Done" or "Cancelled" state.
- **Score**: Priority 1 (urgent) = 4pts, Priority 2 (high) = 3pts, Todo = 2pts, Backlog = 1pt. Highest score first, then oldest.
```

### `### Handoff`

Describes what the agent produces and how it signals completion. Must include:

| Field | Required | Description |
|-------|----------|-------------|
| `output` | yes | What artifacts the agent produces (code changes, PR comment, report, etc.) |
| `done_when` | yes | Concrete completion criteria |
| `notify` | yes | Where/how to report completion (Linear status, GitHub comment, console) |
| `chain` | if applicable | Which agent(s) should run next, and what to pass them |

Example:
```markdown
### Handoff

- **Output**: Code changes on a feature branch, committed with conventional commit message
- **Done when**: Changes compile (`npm run type-check`) and lint passes (`npm run lint`). Do NOT run tests — leave test execution to the owner or the dedicated test agents to avoid orphaned processes.
- **Notify**: Update Linear issue status to "In Progress". Print summary of changes to console.
- **Chain**: After code changes → `tester` (pass the PR number for test review)
```

---

## Protocol for Non-Dispatchable Agents

Some agents are infrastructure (e.g., `git-worktree-manager`, `context-mapper`) and are not dispatched by the flex-worker. These agents do NOT need a Work Protocol section. They are invoked directly by other agents or the user as utilities.

Non-dispatchable agents:
- `git-worktree-manager` — utility for branch isolation
- `context-mapper` — utility for resolving references
- `flex-worker` — meta-agent, not a specialist itself

---

## Chaining Pattern

Agents can chain to other agents via the `chain` field. The calling agent (or flex-worker) is responsible for executing the chain after the specialist completes.

Common chains:
```
feature-specialist → tester       (code changes need test review)
tester → e2e-test-quality         (test issues found, need fixes)
e2e-test-quality → e2e-test-runner (tests written, need execution)
```

The chain is a suggestion, not mandatory. The dispatcher (flex-worker or user) decides whether to follow it.

---

## Idle Behavior

When an agent's scan finds no work, the agent **must stop immediately**. Do not invent work, expand scope, or lower the bar to find something to do.

### Rules

1. **Report idle and exit.** Print a one-line summary and end the cycle:
   ```
   [agent:{name}] No work found. Idle.
   ```

2. **Never do any of the following when idle:**
   - Refactor code that wasn't requested
   - "Improve" tests that are already passing
   - Reorganize files speculatively
   - Create documentation nobody asked for
   - Open issues or PRs for hypothetical problems
   - Broaden search criteria to force a match (e.g., searching all teams instead of CER, or dropping the "unassigned" filter)
   - Re-review PRs that were already reviewed
   - Comment on PRs with unsolicited suggestions

3. **Do not lower the filter bar.** If the Identify section says "skip assigned items" and everything is assigned, the answer is zero work — not "let me also check assigned items."

4. **Do not chain when idle.** If there's no work for the primary role, do not chain to another agent "just in case." Chains only trigger after real work completes.

5. **Idle is a valid state.** It means the system is healthy and caught up. There is no pressure to produce output every cycle.

---

## PR Lifecycle

the human owner is the final reviewer and merger of all PRs. Agents prepare work for his review but never merge.

### Lifecycle States

```
1. agent-working     — specialist is writing code
2. agent-testing     — tester/e2e agents are reviewing
3. ready-for-human    — all agent work is done, awaiting human review
4. feedback          — the owner left comments, agent must address them
5. re-ready          — feedback addressed, awaiting the owner's re-review
6. merged            — the owner merges (only the owner does this)
```

### Signaling "Ready for Review"

When the last agent in the chain completes (usually `tester` or `e2e-test-runner`), the agent that completes the chain must:

1. Add the label `ready-for-review` to the PR:
   ```bash
   gh pr edit <number> --add-label "ready-for-review"
   ```

2. Post a summary comment:
   ```markdown
   [agent:{name}] This PR is ready for review.

   **Work done:**
   - {what the specialist did}
   - {what the tester found / confirmed}

   **Checks passed:**
   - [ ] type-check
   - [ ] lint
   - [ ] related tests

   @${GH_USER} — ready for your review.
   ```

3. Request review from the owner:
   ```bash
   gh pr edit <number> --add-reviewer ${GH_USER}
   ```

### Responding to the owner's Feedback

When the owner leaves comments on a PR, the `feedback-responder` agent picks them up. See `.claude/agents/feedback-responder.md` for the full protocol.

The feedback loop:
1. the owner comments on the PR
2. `feedback-responder` detects the comment, identifies which specialist owns the code
3. The specialist addresses the feedback (code changes, explanations, or pushback with rationale)
4. The specialist resolves the conversation thread and re-labels `ready-for-review`
5. the owner re-reviews

### Rules

- **Agents never merge PRs.** Only the owner merges.
- **Agents never dismiss reviews.** Only the owner can dismiss.
- **Agents never force-push** to branches with open reviews.
- **Agents always tag themselves** in response comments so the owner knows which agent responded.
- If the owner's comment is ambiguous, the agent should ask for clarification in a reply rather than guessing.

---

## Running Agents

### Recommended: `/loop` in separate terminals

Run each agent type in its own terminal tab with `/loop`:

```
Terminal 1:  /loop 10m tester
Terminal 2:  /loop 15m flex-worker
Terminal 3:  /loop 10m feedback-responder
Terminal 4:  /loop 20m folder-structure-enforcer
```

**Interval guidance:**
| Agent | Interval | Rationale |
|-------|----------|-----------|
| `feedback-responder` | 5–10m | the owner's comments need fast turnaround |
| `tester` | 10m | PR reviews are quick reads |
| `flex-worker` | 15–30m | needs time to complete specialist + chain |
| `folder-structure-enforcer` | 30m+ | low-priority, infrequent changes |
| `technical-docs-manager` | 30m+ | low-priority |

### Why `/loop` over alternatives

| Approach | Pros | Cons |
|----------|------|------|
| **`/loop`** (recommended) | Simple, visible, each agent in its own tab, easy to kill | Keeps terminals open |
| **`schedule`** (remote triggers) | Runs without a terminal, survives machine sleep | Harder to debug, no local filesystem access for some checks |
| **Single dispatcher** | One terminal, centralized control | Serializes all work, blocks on long tasks |

`/loop` is the right starting point. Each agent gets its own session, its own context, and you can watch them in real time. If an agent is misbehaving, kill that tab.

### Startup checklist

Before starting loops:
1. Ensure the `ready-for-review` label exists in the repo:
   ```bash
   gh label create "ready-for-review" --color "0E8A16" --description "All agent work done, awaiting the owner's review"
   ```
2. Ensure dev server is running on port 3333 (for e2e-test-runner)
3. Ensure `.auth/user.json` exists (for Playwright)
