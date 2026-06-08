# Filesystem-Backend Review Loop — Design

- **Date:** 2026-06-07
- **Status:** Approved (brainstorm) — pending spec review
- **Repo:** `claude-agent-pipeline`
- **Author:** Ryan Amundson (with Claude)

## Problem

`claude-agent-pipeline` already supports a pluggable **ticket backend**
(`config.backend ∈ {"linear", "filesystem"}`). The `filesystem` backend stores
tickets as JSON files where state is the subdirectory (`needs-work/`,
`in-progress/`, `done/`, …) and transitions are atomic `mv`s.

But the **review/feedback half** of the pipeline is hardwired to GitHub PRs:

- `worker` opens a PR and posts `gh pr comment`.
- `tester` reviews the PR diff and comments on the PR.
- `code-reviewer` does `gh pr comment` + `gh pr edit --add-label`.
- `feedback-responder` reads human comments from PR threads.
- `orchestrator` snapshots state via `gh pr list`.

The config schema even *requires* `repo` + `ghUser` regardless of backend. So
`filesystem` only removes the **Linear** dependency, not the **GitHub** one. A
user who wants to run the whole loop locally cannot — the review stages have no
GitHub-free path.

## Goal

Make `backend: "filesystem"` a **fully GitHub-free** review loop. The **ticket
becomes the unit of review**: the worker leaves a local git branch, reviewers
diff that branch, and every comment / verdict / human-feedback lives inside the
ticket JSON.

## Non-goals (v1)

- **Merge/landing step.** When a ticket reaches `ready-for-human/`, the human
  merges the branch and moves the ticket to `done/` manually. No
  `agent-pipeline done|merge` verb in v1 (see Future Work).
- **Web UI write path.** The dashboard (`ui/server.js`) stays read-only.
  Comments go through the CLI.
- **Refactoring the GitHub path.** The existing GitHub flow is left intact and
  working; we add a parallel filesystem path gated on `config.backend`.

## Decisions (locked in brainstorm)

1. **Review target:** local git branch diff. The worker records `branch` + `base`
   on the ticket; reviewers run `git diff <base>...<branch>` and write their
   verdict onto the ticket. (Not: review the worker's prose summary; not: keep
   PRs and mirror.)
2. **Comment store:** inside the ticket JSON as a `comments: []` array, appended
   via the existing `flock`+`jq` pattern. (Not: a separate append-only log.)
3. **Human touchpoint:** a CLI verb `agent-pipeline comment <id> --body "…"`
   backed by a new `queue/queue-comment.sh` primitive. (Not: web UI; not:
   shell-helper-only.)
4. **Agent backend-awareness:** runtime config-branching — each review agent
   reads `config.backend` and follows the matching path. Both paths coexist in
   the agent `.md`; the filesystem *mechanics* live in the shell primitives so
   the agent text stays thin. (Not: install-time selection; not: a shared
   `rules/backend-*.md` refactor — that is Future Work option B.)

## Detailed Design

### 1. Ticket model extension

Extend the ticket JSON shape (documented in `queue/README.md`). New fields are
additive; the GitHub backend keeps using `pr_url`.

```jsonc
{
  // existing
  "id": "TKT-001",
  "title": "...",
  "description": "...",
  "priority": 2,
  "labels": ["smell", "agent:scanner"],
  "source": { "agent": "scanner", "category": "...", "file": "...", "line": 88 },
  "pr_url": null,               // GitHub backend only
  "stale_count": 0,
  "created_at": "<iso>",
  "updated_at": "<iso>",

  // NEW — filesystem backend review handles
  "branch":   "fix/TKT-001",   // worker's local branch
  "base":     "main",          // diff base; default from config
  "worktree": ".worktrees/TKT-001",

  // NEW — review/comment trail (both backends may use it; filesystem requires it)
  "comments": [
    { "author": "worker",        "verdict": null,   "body": "...", "at": "<iso>" },
    { "author": "tester",        "verdict": "pass", "body": "...", "at": "<iso>" },
    { "author": "code-reviewer", "verdict": "fail", "body": "...", "at": "<iso>" },
    { "author": "human",         "verdict": null,   "body": "rename X", "at": "<iso>" }
  ]
}
```

Comment object:

| field | type | notes |
|---|---|---|
| `author` | string | `worker` / `tester` / `code-reviewer` / `feedback-responder` / `human` |
| `verdict` | `"pass"` \| `"fail"` \| `null` | `null` = informational or human comment |
| `body` | string | markdown |
| `at` | string | ISO-8601 UTC (`date -u`) |

### 2. New primitive — `queue/queue-comment.sh`

```
queue-comment.sh <id> --author <name> [--verdict pass|fail] --body "<text>" [--queue-dir <dir>]
```

- Locates `<id>.json` across the state subdirectories (or honors `--queue-dir`).
- `flock`-serialized read-modify-write that appends a comment object to
  `comments[]` and bumps `updated_at`. Mirrors `queue-update.sh` exactly (same
  lock + `jq` + atomic `.tmp`→rename).
- Exit non-zero with a clear message if the ticket id is not found.
- Reading comments needs **no** new helper — agents `jq` the ticket directly.

Concurrency: same model as the rest of the queue. Comment volume per ticket is
small (a handful over its life), so lock serialization is a non-issue.

### 3. CLI verb — `agent-pipeline comment`

In `bin/cli.js`:

```
agent-pipeline comment <id> --body "<text>" [--verdict pass|fail] [--target <repo>]
```

- Resolves `queueDir` from the target repo's `.pipeline/config.json`.
- Shells out to `queue/queue-comment.sh <id> --author human …`.
- Added to the `HELP` text and the arg parser (a `--body` flag already needs
  wiring; `--verdict` reuses parse style of existing flags).

### 4. Agent behavior (runtime config-branching)

Each review agent gets a **`### Backend: filesystem`** section alongside its
existing GitHub instructions. The agent reads `.pipeline/config.json` →
`backend` and follows the matching branch. The GitHub sections are unchanged.

| Agent | GitHub path (unchanged) | Filesystem path (new) |
|---|---|---|
| **worker** | open PR, `gh pr comment`, set labels | set `branch`/`base`/`worktree` on ticket (via `queue-update.sh`); `queue-comment.sh --author worker`; `queue-claim.sh` `needs-work → in-progress`, then `→ needs-test-review` on completion. **Does not push or open a PR.** |
| **tester** | review PR diff, comment on PR | `git diff <base>...<branch>`; `queue-comment.sh --author tester --verdict pass\|fail`; move `needs-test-review → needs-code-review` (pass) / `→ needs-feedback` (fail) |
| **code-reviewer** | pre-flight scans PR comments; review; `gh pr edit` labels | pre-flight scans `comments[]` for unresolved `author:human`; `git diff <base>...<branch>`; `queue-comment.sh --author code-reviewer --verdict …`; move `needs-code-review → ready-for-human` (pass) / `→ needs-feedback` (fail) |
| **feedback-responder** | reads PR comments, dispatches fix | scans tickets for `author:human` comments with **no later** `[agent:feedback-responder] Addressed` reply; addresses or moves `→ needs-work`; appends an Addressed comment |
| **orchestrator** | `gh pr list` + label snapshot; scan PR comments | `queue-list.sh <state>` snapshot per stage; scan each ticket's `comments[]` for unresolved human comments |

**Resolved-check logic is identical to today**: a human comment is "unresolved"
iff there is no later `[agent:feedback-responder] Addressed` comment. Only the
*source* changes (ticket `comments[]` instead of PR threads). Per the existing
orchestrator rule, the resolved-check is "has no later Addressed reply" — **not**
a timestamp cutoff.

### Diff access

The worker creates the branch in a worktree under `worktreeRoot` (default
`.worktrees/`). The branch is a real ref in the host repo, so reviewers run
`git diff <base>...<branch>` from the repo root without checking anything out
(no interference with the human's working tree — consistent with the worker's
existing "FORBIDDEN on main worktree" guardrail, since reviewers only read).

### Config

No schema change required — `backend: "filesystem"` already exists, and `repo`/
`ghUser` remain (harmless when unused). Optional follow-up: relax the schema so
`repo`/`ghUser` are only `required` when `backend == "github"/"linear"`. Tracked
as a minor follow-up, not blocking.

## Testing

- **`queue-comment.sh` unit/integration tests** (in `test/`, matching the
  existing `e2e`/`fixtures` layout):
  - appends a well-formed comment object;
  - sets `verdict` when passed, `null` when omitted;
  - finds the ticket across state subdirs;
  - concurrent appends (two processes) do not clobber — both land;
  - missing ticket id exits non-zero.
- **Agent `.md` changes** are prompts, not unit-testable. Verify by running a
  single ticket end-to-end through the local loop against a throwaway repo
  (`scanner → ticket → worker → tester → code-reviewer → ready-for-human`,
  plus one `human comment → feedback-responder → needs-work` cycle) and
  inspecting the ticket JSON's `comments[]` and state transitions.

## Ship

1. Bump `claude-agent-pipeline` `0.2.0 → 0.3.0` (additive feature).
2. `npm pack` (and/or publish).
3. Update `context-manager` to consume the new version so its local pipeline
   gets the GitHub-free loop.

## Future Work (explicitly deferred)

- **`done`/merge verb** — `agent-pipeline done <id>` to merge `branch` into
  `base` and move the ticket to `done/`. v1 = manual.
- **Approach B: `rules/backend-{github,filesystem}.md`** — extract backend
  mechanics into shared rule files so agents stay DRY. Larger refactor; do later
  if the per-agent duplication bites.
- **Web UI write path** — comment box in the dashboard (needs POST handling).
- **Schema tightening** — make `repo`/`ghUser` conditionally required by backend.

## Risk / open issue

The target repo currently has substantial uncommitted WIP on the `feat/ui`
branch (incl. `bin/cli.js` and `package.json`, both of which this work edits).
Isolation strategy must be agreed before implementation to avoid entangling or
stashing that WIP (per the project's no-stash-parallel-work rule).
