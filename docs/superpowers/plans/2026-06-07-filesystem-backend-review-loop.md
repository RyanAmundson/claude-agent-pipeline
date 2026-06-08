# Filesystem-Backend Review Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `backend: "filesystem"` a fully GitHub-free review loop where the ticket is the unit of review — comments/verdicts live in the ticket JSON and reviewers diff a local branch.

**Architecture:** Add one queue primitive (`queue-comment.sh`) that appends to a ticket's `comments[]` under `flock`, one CLI verb (`agent-pipeline comment`) for the human touchpoint, and a backend-conditional **"Backend: filesystem"** section to each review agent (`worker`, `tester`, `code-reviewer`, `feedback-responder`, `orchestrator`) that reads `config.backend` and uses the queue primitives + `git diff` instead of `gh`. The existing GitHub path is left untouched.

**Tech Stack:** POSIX bash + `jq` + `flock` (mirroring `queue-update.sh`/`queue-claim.sh`); Node ≥18 ESM CLI (`bin/cli.js`, zero deps); bash e2e tests (`test/e2e/*.sh` + `lib/assertions.sh`); markdown agent prompts.

**Repo / branch:** `claude-agent-pipeline`, branch `feat/fs-review-loop` (already created; spec at `docs/superpowers/specs/2026-06-07-filesystem-backend-review-loop-design.md`).

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `queue/queue-comment.sh` | **Create** | Append `{author,verdict,body,at}` to a ticket's `comments[]` under flock; locate ticket across state dirs. |
| `test/e2e/04-queue-comment.sh` | **Create** | Free (no-claude) test for the primitive + the CLI verb. |
| `bin/cli.js` | **Modify** | Add `comment` verb (flags `--body`/`--verdict`/`--author`), `resolveQueueDir()`, and show `branch`/`base`/`comments` in `ticket`. |
| `agents/worker.md` | **Modify** | Filesystem path: record `branch`/`base`/`worktree`, comment as `worker`, transition via queue. No PR. |
| `agents/tester.md` | **Modify** | Filesystem path: `git diff base...branch`, comment+verdict, transition. |
| `agents/code-reviewer.md` | **Modify** | Filesystem path: pre-flight human-comment scan, diff review, comment+verdict, transition. |
| `agents/feedback-responder.md` | **Modify** | Filesystem path: scan `comments[]` for unresolved human comments, address, move to `needs-work`. |
| `agents/orchestrator.md` | **Modify** | Filesystem path: snapshot via `queue-list.sh`; scan tickets for unresolved human comments. |
| `queue/README.md` | **Modify** | Document new ticket fields + `queue-comment.sh`. |
| `package.json` | **Modify** | Version `0.2.0 → 0.3.0`. |

---

## Task 1: `queue-comment.sh` primitive (TDD)

**Files:**
- Create: `queue/queue-comment.sh`
- Test: `test/e2e/04-queue-comment.sh`

- [ ] **Step 1: Write the failing test**

Create `test/e2e/04-queue-comment.sh`:

```bash
#!/usr/bin/env bash
# 04-queue-comment.sh — unit test for queue/queue-comment.sh + the `comment`
# CLI verb. No claude, $0, ~2s. Portable: the concurrency sub-test is skipped
# where flock(1) is unavailable.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
. "$HERE/lib/assertions.sh"
QC="$REPO_ROOT/queue/queue-comment.sh"

echo
echo "═══ 04-queue-comment ══════════════════════════════════════════════"

WORK="$(mktemp -d -t ap-qc)"
trap 'rm -rf "$WORK"' EXIT
QDIR="$WORK/.pipeline/queue"
mkdir -p "$QDIR/needs-code-review" "$QDIR/needs-feedback"
cat > "$QDIR/needs-code-review/TKT-001.json" <<'JSON'
{ "id": "TKT-001", "title": "demo", "priority": 2,
  "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z" }
JSON

# 1) append a comment with a verdict
bash "$QC" TKT-001 --author tester --verdict pass --body "regression test present" --queue-dir "$QDIR" >/dev/null
F="$QDIR/needs-code-review/TKT-001.json"
assert_eq "$(jq '.comments | length' "$F")" "1" "one comment appended"
assert_eq "$(jq -r '.comments[0].author' "$F")" "tester" "author recorded"
assert_eq "$(jq -r '.comments[0].verdict' "$F")" "pass" "verdict recorded"
assert_eq "$(jq -r '.comments[0].body' "$F")" "regression test present" "body recorded"
assert_eq "$(jq -r '.comments[0].at | (. != null and . != "")' "$F")" "true" "timestamp set"

# 2) omitted verdict -> JSON null
bash "$QC" TKT-001 --author human --body "rename to fooBar" --queue-dir "$QDIR" >/dev/null
assert_eq "$(jq -r '.comments[1].verdict' "$F")" "null" "omitted verdict is JSON null"
assert_eq "$(jq -r '.comments[1].author' "$F")" "human" "second author recorded"

# 3) finds ticket across states without --state
mv "$F" "$QDIR/needs-feedback/TKT-001.json"
F="$QDIR/needs-feedback/TKT-001.json"
bash "$QC" TKT-001 --author code-reviewer --verdict fail --body "layer violation" --queue-dir "$QDIR" >/dev/null
assert_eq "$(jq '.comments | length' "$F")" "3" "found across states; third comment appended"

# 4) missing ticket exits 1
set +e; bash "$QC" NOPE --author x --body y --queue-dir "$QDIR" >/dev/null 2>&1; RC=$?; set -e
assert_eq "$RC" "1" "missing ticket exits 1"

# 5) missing --body exits 2
set +e; bash "$QC" TKT-001 --author x --queue-dir "$QDIR" >/dev/null 2>&1; RC=$?; set -e
assert_eq "$RC" "2" "missing --body exits 2"

# 6) invalid verdict exits 2
set +e; bash "$QC" TKT-001 --author x --body y --verdict maybe --queue-dir "$QDIR" >/dev/null 2>&1; RC=$?; set -e
assert_eq "$RC" "2" "invalid --verdict exits 2"

# 7) concurrency: 5 parallel appends all land (requires flock)
if command -v flock >/dev/null 2>&1; then
  before=$(jq '.comments | length' "$F")
  for i in 1 2 3 4 5; do bash "$QC" TKT-001 --author "w$i" --body "c$i" --queue-dir "$QDIR" >/dev/null & done
  wait
  assert_eq "$(jq '.comments | length' "$F")" "$((before + 5))" "all 5 concurrent appends landed"
else
  echo "  (skip concurrency: flock unavailable)"
fi

# 8) CLI verb: `agent-pipeline comment` resolves queueDir from config and appends author=human
cat > "$WORK/.pipeline/config.json" <<'JSON'
{ "repo": "x/y", "ghUser": "z", "backend": "filesystem",
  "filesystem": { "queueDir": ".pipeline/queue" } }
JSON
node "$REPO_ROOT/bin/cli.js" comment TKT-001 --body "via cli" --target "$WORK" >/dev/null
LAST_AUTHOR=$(jq -r '.comments[-1].author' "$F")
LAST_BODY=$(jq -r '.comments[-1].body' "$F")
assert_eq "$LAST_AUTHOR" "human" "CLI defaults author to human"
assert_eq "$LAST_BODY" "via cli" "CLI body recorded"

echo
echo "${_GRN}✓ 04-queue-comment passed${_RST}"
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bash test/e2e/04-queue-comment.sh`
Expected: FAIL fast — `queue/queue-comment.sh` does not exist (`bash: .../queue-comment.sh: No such file or directory`), so the first `bash "$QC"` errors and the first assertion fails.

- [ ] **Step 3: Create the primitive**

Create `queue/queue-comment.sh` (mirrors `queue-update.sh`'s flock+jq+atomic-mv pattern; adds cross-state lookup and a `flock`-optional fallback so it also works where `flock(1)` is absent):

```bash
#!/usr/bin/env bash
# queue-comment.sh — append a comment to a ticket's comments[] under flock.
#
# Usage:
#   queue-comment.sh <id> --author <name> --body <text> \
#       [--verdict pass|fail] [--state <state>] [--queue-dir <dir>]
#
# Example:
#   queue-comment.sh TKT-001 --author code-reviewer --verdict fail \
#       --body "layer violation in src/x.ts"
#
# Locates <id>.json across the queue state subdirectories (or honors --state),
# then appends { author, verdict, body, at } to .comments and bumps updated_at.
# Serialized via flock(1) when available (matching queue-update.sh); falls back
# to a plain atomic tmp->rename when flock is absent (loses cross-process
# serialization only — single-writer use is still safe).

set -euo pipefail

ID="${1:-}"
shift 1 2>/dev/null || true

AUTHOR=""
BODY=""
VERDICT="null"
STATE=""
QUEUE_DIR=".pipeline/queue"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --author)    AUTHOR="$2"; shift 2 ;;
        --body)      BODY="$2"; shift 2 ;;
        --verdict)   VERDICT="$2"; shift 2 ;;
        --state)     STATE="$2"; shift 2 ;;
        --queue-dir) QUEUE_DIR="$2"; shift 2 ;;
        *)           shift ;;
    esac
done

if [[ -z "$ID" || -z "$AUTHOR" || -z "$BODY" ]]; then
    echo "usage: $0 <id> --author <name> --body <text> [--verdict pass|fail] [--state <state>] [--queue-dir <dir>]" >&2
    exit 2
fi

if [[ "$VERDICT" != "null" && "$VERDICT" != "pass" && "$VERDICT" != "fail" ]]; then
    echo "invalid --verdict: $VERDICT (want pass|fail)" >&2
    exit 2
fi

# Locate the ticket file.
FILE=""
if [[ -n "$STATE" ]]; then
    FILE="$QUEUE_DIR/$STATE/$ID.json"
else
    for d in "$QUEUE_DIR"/*/; do
        if [[ -f "$d$ID.json" ]]; then FILE="$d$ID.json"; break; fi
    done
fi

if [[ -z "$FILE" || ! -f "$FILE" ]]; then
    echo "no such ticket: $ID" >&2
    exit 1
fi

NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [[ "$VERDICT" == "null" ]]; then VERDICT_JSON="null"; else VERDICT_JSON="\"$VERDICT\""; fi

_apply() {
    local tmp="$FILE.tmp.$$"
    jq --arg author "$AUTHOR" \
       --arg body "$BODY" \
       --arg at "$NOW" \
       --argjson verdict "$VERDICT_JSON" \
       '.comments = ((.comments // []) + [{author: $author, verdict: $verdict, body: $body, at: $at}]) | .updated_at = $at' \
       "$FILE" > "$tmp"
    mv "$tmp" "$FILE"
}

LOCK="$QUEUE_DIR/.lock"
mkdir -p "$QUEUE_DIR"
touch "$LOCK"

if command -v flock >/dev/null 2>&1; then
    ( flock -x 200; _apply ) 200>"$LOCK"
else
    _apply
fi

echo "commented: $ID ($AUTHOR)"
```

- [ ] **Step 4: Make it executable**

Run: `chmod +x queue/queue-comment.sh`

- [ ] **Step 5: Run the test, verify it passes**

Run: `bash test/e2e/04-queue-comment.sh`
Expected: PASS — ends with `✓ 04-queue-comment passed`. (If `flock` is absent locally, step 7 prints `(skip concurrency: flock unavailable)` and the rest still passes.)

Note: CLI sub-test (#8) depends on Task 2. If running Task 1 in isolation, expect #8 to fail until Task 2 lands; the steps below add it. If you prefer strict TDD per-task, temporarily comment out section #8, then restore it in Task 2 Step 5.

- [ ] **Step 6: Commit**

```bash
git add queue/queue-comment.sh test/e2e/04-queue-comment.sh
git commit -m "feat(queue): add queue-comment.sh primitive for ticket comments"
```

---

## Task 2: `agent-pipeline comment` CLI verb

**Files:**
- Modify: `bin/cli.js` (import, HELP, parseFlags, dispatch, new functions)

- [ ] **Step 1: Add `execFileSync` to the child_process import**

Edit `bin/cli.js` line 8:

```js
import { execSync, execFileSync, spawn } from 'node:child_process';
```

- [ ] **Step 2: Add the `comment` line to HELP**

In the `HELP` template, after the `ticket <id> ...` block (currently lines 36–37), insert:

```
  agent-pipeline comment <id> --body "..." [--verdict pass|fail] [--target <p>]
                                              Append a human comment to a ticket (filesystem backend)
```

- [ ] **Step 3: Add flags to parseFlags**

In the `flags` object literal in `parseFlags` (currently lines 77–83), add `body`, `verdict`, `author`:

```js
    prompt: null, wait: false, detach: false, stream: false, follow: false, runId: null,
    allowedTools: [], disallowedTools: [], maxBudgetUsd: null, model: null,
    body: null, verdict: null, author: null,
```

And in the `switch (a)` arg loop (after the `--model` case, currently line 114), add:

```js
      case '--body': flags.body = args[++i]; break;
      case '--verdict': flags.verdict = args[++i]; break;
      case '--author': flags.author = args[++i]; break;
```

- [ ] **Step 4: Add the dispatch case**

In the main `switch (cmd)` (currently lines 324–343), add a case after `case 'ticket':` (line 336):

```js
  case 'comment': runComment(positional, flags); break;
```

- [ ] **Step 5: Add `resolveQueueDir` and `runComment`**

Add these two functions next to `targetOf` (after line 349):

```js
function resolveQueueDir(target) {
  // Default matches config.schema.json filesystem.queueDir default.
  let queueDir = '.pipeline/queue';
  const cfgPath = join(target, '.pipeline', 'config.json');
  if (existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
      if (cfg.filesystem?.queueDir) queueDir = cfg.filesystem.queueDir;
    } catch {}  // optional config read — same pattern as detectDeps()
  }
  return join(target, queueDir);
}

function runComment(positional, flags) {
  if (positional.length !== 1) die(`Usage: agent-pipeline comment <id> --body "..." [--verdict pass|fail] [--target <p>]`);
  if (!flags.body) die(`comment: --body is required`);
  if (flags.verdict && !['pass', 'fail'].includes(flags.verdict)) die(`comment: --verdict must be pass|fail`);
  const target = targetOf(flags);
  const queueDir = resolveQueueDir(target);
  const script = join(PLUGIN_ROOT, 'queue', 'queue-comment.sh');
  const args = [script, positional[0], '--author', flags.author || 'human', '--body', flags.body, '--queue-dir', queueDir];
  if (flags.verdict) args.push('--verdict', flags.verdict);
  try {
    execFileSync('bash', args, { stdio: 'inherit' });
  } catch (err) {
    process.exit(err.status || 1);
  }
}
```

- [ ] **Step 6: Run the full test (now including the CLI sub-test)**

Run: `bash test/e2e/04-queue-comment.sh`
Expected: PASS including assertions `CLI defaults author to human` and `CLI body recorded`.

- [ ] **Step 7: Smoke the help + verb**

Run: `node bin/cli.js --help | grep -A1 'comment <id>'`
Expected: prints the comment usage line.
Run: `node bin/cli.js comment` (no args)
Expected: exits non-zero with `Usage: agent-pipeline comment ...`.

- [ ] **Step 8: Commit**

```bash
git add bin/cli.js
git commit -m "feat(cli): add 'comment' verb for human ticket comments"
```

---

## Task 3: Show `branch`/`base`/`comments` in `ticket`

**Files:**
- Modify: `bin/cli.js` `runTicket` (currently lines 410–424)

- [ ] **Step 1: Add display lines**

In `runTicket`, after the `if (t.pr_url) ...` line (line 420), insert:

```js
  if (t.branch) console.log(`  branch:      ${t.branch}${t.base ? '  (base ' + t.base + ')' : ''}`);
  if (t.worktree) console.log(`  worktree:    ${t.worktree}`);
```

And after the `if (t.description) ...` line (line 423), append:

```js
  if (Array.isArray(t.comments) && t.comments.length) {
    console.log(`\n  comments (${t.comments.length}):`);
    for (const c of t.comments) {
      const v = c.verdict ? ` [${c.verdict}]` : '';
      console.log(`    ${(c.author || '?').padEnd(18)}${v}  ${(c.body || '').split('\n')[0]}`);
    }
  }
```

- [ ] **Step 2: Verify against a tmp ticket**

Run:
```bash
T=$(mktemp -d); mkdir -p "$T/.pipeline/queue/ready-for-human"
cat > "$T/.pipeline/queue/ready-for-human/TKT-9.json" <<'JSON'
{"id":"TKT-9","title":"x","branch":"fix/TKT-9","base":"main","comments":[{"author":"tester","verdict":"pass","body":"ok","at":"t"}]}
JSON
node bin/cli.js ticket TKT-9 --target "$T"; rm -rf "$T"
```
Expected: output includes `branch:      fix/TKT-9  (base main)` and a `comments (1):` block listing `tester [pass]  ok`.

(Note: `getTicket` already returns the raw ticket JSON, so `--json` includes `comments`/`branch`/`base` with no API change.)

- [ ] **Step 3: Commit**

```bash
git add bin/cli.js
git commit -m "feat(cli): show branch/base/comments in 'ticket' output"
```

---

## Task 4: Worker agent — filesystem path

**Files:**
- Modify: `agents/worker.md`

- [ ] **Step 1: Add the backend-aware note after the Scope line**

After line 10 (`**Scope**: ...`), insert:

```markdown

**Backend-aware:** The Process below describes the GitHub/Linear backend. Read `.pipeline/config.json` first — if `backend: "filesystem"`, follow the **Backend: filesystem** section at the bottom instead of opening a PR.
```

- [ ] **Step 2: Append the filesystem section at end of file**

After the `## Handoff` section (line 54), append:

```markdown

## Backend: filesystem (GitHub-free)

When `.pipeline/config.json` has `backend: "filesystem"`, do NOT use `gh`, do NOT open a PR, and do NOT push. The ticket is the unit of review.

1. **Claim**: `queue/queue-claim.sh <id> needs-work in-progress --queue-dir <queueDir>` (skip the ticket if claim fails — another worker won).
2. **Worktree + branch** exactly as in step 5a (worktree under `worktreeRoot`, branch `<branchPrefix><id>`), but branch from the local base (`config base` or the repo default branch) and **never push**.
3. **Implement** the fix and write regression tests. Run the `verify` commands from config (e.g. `npm run type-check && npm run lint`). Do not run the full test suite (orphaned-process risk).
4. **Record review handles** on the ticket:
   `queue/queue-update.sh in-progress <id> '.branch="<branch>" | .base="<base>" | .worktree="<path>"' --queue-dir <queueDir>`
5. **Post provenance** to the ticket:
   `queue/queue-comment.sh <id> --author worker --body "<what changed; regression test path; verify results>" --queue-dir <queueDir>`
6. **Hand off**: `queue/queue-claim.sh <id> in-progress needs-test-review --queue-dir <queueDir>`.

The ticket's `comments[]` plus `branch`/`base` ARE the audit trail — there is no PR. The forbidden-commands rule on the main worktree (step 5c) still applies.
```

- [ ] **Step 3: Verify markdown renders / no broken anchors**

Run: `grep -n "Backend: filesystem" agents/worker.md`
Expected: one match for the new section.

- [ ] **Step 4: Commit**

```bash
git add agents/worker.md
git commit -m "feat(worker): add filesystem-backend review path"
```

---

## Task 5: Tester agent — filesystem path

**Files:**
- Modify: `agents/tester.md`

- [ ] **Step 1: Append the filesystem section after the `## Work Protocol` block (end of file, after line 262)**

```markdown

---

## Backend: filesystem (GitHub-free)

When `.pipeline/config.json` has `backend: "filesystem"`, do NOT use `gh`. Review the worker's local branch:

1. **Pick** a ticket in `needs-test-review/` (oldest, highest priority). Skip any whose `comments[]` already contains an `author:"tester"` entry for the current round.
2. **Read handles**: the ticket's `branch` and `base`.
3. **Get the diff**:
   ```bash
   git -C <repoRoot> diff --name-only <base>...<branch>
   git -C <repoRoot> diff <base>...<branch>
   ```
   Read the changed source files before judging test adequacy (Section 7 still applies).
4. **Apply** the test-quality checklist (Sections 1–5) to the diff.
5. **Post findings + verdict**:
   `queue/queue-comment.sh <id> --author tester --verdict pass|fail --body "<findings, file:line, suggested fixes>" --queue-dir <queueDir>`
6. **Transition**: pass → `queue/queue-claim.sh <id> needs-test-review needs-code-review`; fail → `queue/queue-claim.sh <id> needs-test-review needs-feedback` (both `--queue-dir <queueDir>`).

**Idle**: if `needs-test-review/` is empty, stop. The output-format sections (3) still describe the comment body; post it to the ticket, not a PR.
```

- [ ] **Step 2: Verify**

Run: `grep -n "Backend: filesystem" agents/tester.md`
Expected: one match.

- [ ] **Step 3: Commit**

```bash
git add agents/tester.md
git commit -m "feat(tester): add filesystem-backend review path"
```

---

## Task 6: Code-reviewer agent — filesystem path

**Files:**
- Modify: `agents/code-reviewer.md`

- [ ] **Step 1: Append the filesystem section at end of file**

```markdown

---

## Backend: filesystem (GitHub-free)

When `.pipeline/config.json` has `backend: "filesystem"`, do NOT use `gh`:

1. **Pick** a ticket in `needs-code-review/`. Skip any with an existing `author:"code-reviewer"` comment for the current round.
2. **Pre-flight (human first)**: read the ticket's `comments[]`. A comment with `author:"human"` is **unresolved** if there is no LATER comment with `author:"feedback-responder"` whose body contains "Addressed". If any unresolved human comment exists, do NOT review — move the ticket to feedback: `queue/queue-claim.sh <id> needs-code-review needs-feedback --queue-dir <queueDir>` and stop. Use the "no later Addressed reply" rule, NOT a timestamp cutoff.
3. **Review the diff**: `git -C <repoRoot> diff <base>...<branch>` against the code-review checklist.
4. **Post summary + verdict**:
   `queue/queue-comment.sh <id> --author code-reviewer --verdict pass|fail --body "<summary with specific findings>" --queue-dir <queueDir>`
5. **Transition**: pass → `queue/queue-claim.sh <id> needs-code-review ready-for-human`; fail → `queue/queue-claim.sh <id> needs-code-review needs-feedback` (both `--queue-dir <queueDir>`).

`ready-for-human/` is the human's queue — the human merges `branch` into `base` and moves the ticket to `done/` manually. Do not merge.
```

- [ ] **Step 2: Verify**

Run: `grep -n "Backend: filesystem" agents/code-reviewer.md`
Expected: one match.

- [ ] **Step 3: Commit**

```bash
git add agents/code-reviewer.md
git commit -m "feat(code-reviewer): add filesystem-backend review path"
```

---

## Task 7: Feedback-responder agent — filesystem path

**Files:**
- Modify: `agents/feedback-responder.md`

- [ ] **Step 1: Append the filesystem section at end of file**

```markdown

---

## Backend: filesystem (GitHub-free)

When `.pipeline/config.json` has `backend: "filesystem"`, monitor the ticket queue instead of PR threads:

1. **Scan** every ticket (all state subdirs) for `comments[]` entries with `author:"human"` that are **unresolved** — i.e. have no LATER comment with `author:"feedback-responder"` whose body contains "Addressed". Use the "no later Addressed reply" rule, NOT a timestamp cutoff.
2. For each unresolved human comment: address it (make the change directly, or dispatch a worker) or reply asking for clarification.
3. **Record resolution** on the ticket:
   `queue/queue-comment.sh <id> --author feedback-responder --body "Addressed: <what you did or what you need>" --queue-dir <queueDir>`
4. If the comment requires code changes, move the ticket back so a worker re-implements:
   `queue/queue-claim.sh <id> <current-state> needs-work --queue-dir <queueDir>` (the worker re-enters the loop and re-records `branch`/comments).

The pipeline is NEVER idle while an unresolved human comment exists, regardless of the ticket's state.
```

- [ ] **Step 2: Verify**

Run: `grep -n "Backend: filesystem" agents/feedback-responder.md`
Expected: one match.

- [ ] **Step 3: Commit**

```bash
git add agents/feedback-responder.md
git commit -m "feat(feedback-responder): add filesystem-backend path"
```

---

## Task 8: Orchestrator agent — filesystem snapshot

**Files:**
- Modify: `agents/orchestrator.md`

- [ ] **Step 1: Append the filesystem section at end of file**

```markdown

## Backend: filesystem (GitHub-free)

When `.pipeline/config.json` has `backend: "filesystem"`, take the pipeline snapshot from the queue, not `gh pr list`:

- **Snapshot** each stage with `queue/queue-list.sh <state> --queue-dir <queueDir>` (or `agent-pipeline status --json`) for: `needs-triage`, `needs-review`, `needs-work`, `needs-test-review`, `needs-code-review`, `needs-feedback`, `ready-for-human`. Dispatch the same agent per stage as the GitHub table.
- **Unresolved-human-comment scan (every cycle)**: for every ticket in every state, read `comments[]` and flag any `author:"human"` comment with no LATER `author:"feedback-responder"` "Addressed" reply → dispatch `feedback-responder`. Do NOT use a timestamp cutoff. The pipeline is never idle while such a comment exists.
- **`ready-for-human/`** is the human's queue (merge + move to `done/` manually) — no dispatch.
- There are no PRs to scan and no `blocked-by:*` GitHub labels; backlog readiness is simply non-empty `needs-work/`.
```

- [ ] **Step 2: Verify**

Run: `grep -n "Backend: filesystem" agents/orchestrator.md`
Expected: one match.

- [ ] **Step 3: Commit**

```bash
git add agents/orchestrator.md
git commit -m "feat(orchestrator): add filesystem-backend snapshot path"
```

---

## Task 9: Document the ticket model + helper

**Files:**
- Modify: `queue/README.md`

- [ ] **Step 1: Extend the "Ticket file shape" example**

In `queue/README.md`, in the `## Ticket file shape` JSON block, after the `"pr_url": null,` line add:

```json
  "branch": "fix/TKT-001",
  "base": "main",
  "worktree": ".worktrees/TKT-001",
  "comments": [
    { "author": "code-reviewer", "verdict": "fail", "body": "layer violation in src/x.ts", "at": "2026-06-07T10:05:00Z" }
  ],
```

And below the shape, add a short note:

```markdown
For the GitHub-free review loop, `branch`/`base` replace `pr_url` as the review
handle (reviewers run `git diff <base>...<branch>`), and `comments[]` holds the
review/feedback trail. Each comment is `{ author, verdict, body, at }` where
`verdict` is `"pass" | "fail" | null` (`null` = informational / human).
```

- [ ] **Step 2: Add a `queue-comment.sh` helper subsection**

In the `## Helpers` section, after the `### queue-update.sh` block, add:

```markdown
### `queue-comment.sh <id> --author <name> --body "<text>" [--verdict pass|fail]`

Append a comment to a ticket's `comments[]` (flock-serialized, atomic). Locates
the ticket across state dirs (or pass `--state`). Reviewers use this with
`--verdict`; humans use the `agent-pipeline comment` CLI verb (author `human`).

```bash
queue-comment.sh TKT-001 --author tester --verdict pass --body "regression test present"
```
```

- [ ] **Step 3: Commit**

```bash
git add queue/README.md
git commit -m "docs(queue): document comments[]/branch/base + queue-comment.sh"
```

---

## Task 10: Full e2e mechanics verification (free) + manual live note

**Files:**
- Run only: `test/e2e/04-queue-comment.sh`, `test/e2e/run-all.sh`

- [ ] **Step 1: Run the focused test**

Run: `bash test/e2e/04-queue-comment.sh`
Expected: `✓ 04-queue-comment passed`.

- [ ] **Step 2: Run the whole e2e suite (smoke + scanner + pipeline + new)**

Run: `npm run test:e2e`
Expected: SUMMARY line with the new `04-queue-comment.sh` counted in `passed` (live tests skip without `CAP_E2E_LIVE=1`). No `failed`.

- [ ] **Step 3: Manual live verification (per spec — needs claude + budget)**

This proves the agent *prompts* (Tasks 4–8), which are not unit-testable. On a throwaway repo with `backend: "filesystem"`:
1. Seed a `needs-work/` ticket.
2. Dispatch `worker` → confirm ticket gains `branch`/`base` + an `author:worker` comment and lands in `needs-test-review/`.
3. Dispatch `tester` → confirm an `author:tester` verdict comment and transition.
4. Dispatch `code-reviewer` → confirm transition to `ready-for-human/`.
5. `agent-pipeline comment <id> --body "rename X"` → dispatch `feedback-responder` → confirm `Addressed` comment and move back to `needs-work/`.

Paste the observed `agent-pipeline ticket <id>` output (showing `comments[]` + states) into the Task 11 commit / PR body as the verification record. Do NOT mark the feature complete on the strength of the bash test alone.

---

## Task 11: Version bump + pack + ship prep

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Bump version**

Edit `package.json` line 3:

```json
  "version": "0.3.0",
```

- [ ] **Step 2: Verify packaging includes the new primitive**

Run: `npm run pack:dry 2>&1 | grep -E 'queue/queue-comment.sh|agents/worker.md'`
Expected: both paths listed (the `files` array already includes `queue/` and `agents/`).

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: release v0.3.0 — filesystem-backend review loop"
```

- [ ] **Step 4: (When ready) consume in context-manager**

After review/merge: `npm pack` here, then in `context-manager` update the dependency/reinstall the pipeline (`agent-pipeline install <target>`) so its local loop picks up the GitHub-free path. Out of scope for this branch's commits.

---

## Self-Review (completed during planning)

- **Spec coverage:** §1 ticket model → Tasks 1/3/9; §2 queue-comment.sh → Task 1; §3 CLI verb → Task 2; §4 agent behavior (worker/tester/code-reviewer/feedback-responder/orchestrator) → Tasks 4–8; testing → Tasks 1/10; ship → Task 11. Non-goals (merge verb, UI write, GitHub-path refactor) are honored — no tasks add them.
- **Type/name consistency:** comment object `{author, verdict, body, at}` is identical across queue-comment.sh, the test, `runTicket`, README, and every agent section. Flags `--author/--body/--verdict/--state/--queue-dir` match between the script, the test, and the CLI wrapper. States used (`needs-work`, `in-progress`, `needs-test-review`, `needs-code-review`, `needs-feedback`, `ready-for-human`) match `setup.sh` and `queue/README.md`.
- **Placeholders:** none — every step has concrete code/commands. `<id>`, `<base>`, `<branch>`, `<queueDir>`, `<repoRoot>` are runtime-substituted values the agent resolves, not plan gaps.
- **Known assumption:** `jq` + `date -u` required (already used by the queue layer); `flock` used when present, with a documented single-writer fallback when absent.
