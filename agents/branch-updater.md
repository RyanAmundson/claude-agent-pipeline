# Branch Updater Agent

> **Terminology**: If `docs/glossary.md` exists, consult it before using or coining project-specific terms (your project's domain terms). If you encounter a term not in the glossary or a usage that conflicts with it, report it in your summary so the orchestrator can dispatch glossary-maintainer. Never paraphrase a definition — read the glossary entry or ask.

**Role**: Keep PR branches in sync with main. Detect conflicts early (cheap), resolve them, and only push when the PR is ready for human review.

**Input**: All open PR branches
**Output**: Conflict-free, up-to-date branches at `pipeline:ready-for-human`
**Provenance**: `agent:branch-updater`
**Scope**: ${REPO_SLUG} only. Only **open** PRs authored by `${GH_USER}`. Skip bots and other authors per `.pipeline/config.json` allowlist. Skip merged/closed PRs.

## Process

1. Fetch latest main: `git fetch origin main`
2. For each open PR branch, run the two-phase check:

### Phase 1: Conflict Detection (no push, no CI)

For every open PR branch regardless of pipeline state:

```bash
# Check if branch is behind main
git rev-list --count origin/main..origin/<branch>  # commits ahead
git rev-list --count origin/<branch>..origin/main  # commits behind

# If behind, check for conflicts without touching anything
git merge-tree $(git merge-base origin/main origin/<branch>) origin/main origin/<branch>
```

Categorize each branch:
- **Up-to-date**: 0 commits behind main → skip
- **Behind, no conflicts**: Behind main but merge is clean → note it, don't push yet
- **Behind, has conflicts**: Merge would conflict → needs resolution

### Phase 2: Action Based on Pipeline State

| Pipeline State | Branch Status | Action | CI? |
|---|---|---|---|
| Any early stage | Up-to-date | Skip | No |
| Any early stage | Behind, clean | Skip (will update later) | No |
| Any early stage | Behind, conflicts | Label `pipeline:needs-conflict-resolution`, comment with conflicting files | No |
| `pipeline:ready-for-human` | Up-to-date | Skip | No |
| `pipeline:ready-for-human` | Behind, clean | Merge main into branch, push | Yes (once) |
| `pipeline:ready-for-human` | Behind, conflicts | **Remove `pipeline:ready-for-human`** and add `pipeline:needs-conflict-resolution` — a conflicted PR is not mergeable, so it must leave the human-review queue. Conflict-resolver resolves, then re-check | No (until resolved) |

### Conflict Resolution Handoff

When conflicts are detected, swap the labels and post a comment. **If the PR was at `pipeline:ready-for-human`, remove that label** — a PR that conflicts with main cannot be merged, so it must not sit in the human-review queue while conflicts are outstanding:

```bash
# Only for a PR that was at pipeline:ready-for-human:
gh pr edit <number> --remove-label "pipeline:ready-for-human" \
  --add-label "pipeline:needs-conflict-resolution,agent:branch-updater"

# For an early-stage PR, keep its underlying state label (it's still accurate) and just add:
gh pr edit <number> --add-label "pipeline:needs-conflict-resolution,agent:branch-updater"
```

```
[agent:branch-updater] This branch has merge conflicts with main.

Conflicting files:
- src/features/agents/[components]/AgentCard/AgentCard.tsx
- src/pages-content/protected/policies/page.tsx

This PR was at pipeline:ready-for-human; a conflicted branch is not mergeable, so I'm
removing pipeline:ready-for-human and labeling pipeline:needs-conflict-resolution for the
conflict-resolver. It returns to ready-for-human once the merge is clean.
```

The **conflict-resolver** (not the feedback-responder — that agent handles human comments, not git merges) checks out the branch, merges main, and resolves the conflicts with a tiered strategy. It then re-routes by overlap tier: Tier A/B return the PR to `pipeline:ready-for-human` (CI confirms), Tier C downgrades to `pipeline:needs-test-review` so the PR flows through tester → code-reviewer before the branch-updater does any final merge+push. Genuinely ambiguous conflicts are escalated back to `pipeline:needs-feedback` for the human. Detection is your job; resolution is the conflict-resolver's.

### Push Rules

Only push (triggering CI) when ALL of these are true:
1. PR is labeled `pipeline:ready-for-human`
2. Branch is behind main
3. Merge is conflict-free
4. No unresolved the owner comments on the PR

After pushing, add a comment:
```
[agent:branch-updater] Updated branch with main (was N commits behind). Ready for review.
```

### Post-merge re-routing (avoid unnecessary re-verification)

After merging main into a branch that was at `pipeline:ready-for-human`, decide how much re-verification is needed by comparing the **set of files changed by main** against the **set of files changed by the PR** (relative to the merge base before this update).

```bash
MERGE_BASE=$(git merge-base origin/main HEAD~1)          # commit BEFORE this merge
MAIN_FILES=$(git diff --name-only $MERGE_BASE origin/main | sort -u)
PR_FILES=$(git diff --name-only $MERGE_BASE HEAD~1 | sort -u)   # HEAD~1 = branch tip before merge
OVERLAP=$(comm -12 <(echo "$MAIN_FILES") <(echo "$PR_FILES"))
```

Then route by one of three tiers:

| Tier | Condition | Routing | Rationale |
|---|---|---|---|
| **A. No overlap** | `OVERLAP` is empty | Keep `pipeline:ready-for-human`. CI reruns automatically on push; if CI is green, the PR stays merge-ready. | Main's changes can't semantically collide with the PR's changes — re-testing is busywork. |
| **B. Overlap, but no same-file edit** | Overlap comes only from test-infrastructure or config files (`package.json`, `package-lock.json`, `vite.config.ts`, `playwright.config.ts`, `.github/**`, root configs) that aren't imported from the PR's source files | Keep `pipeline:ready-for-human`. If CI goes red, downgrade to `pipeline:needs-feedback`. | Config/dependency changes don't change runtime behavior of the PR's code. |
| **C. Same source files touched** | Overlap includes any `src/**` file the PR also touched | Downgrade to `pipeline:needs-test-review` (current behavior). | Real risk of semantic merge — both the PR and main changed the same file, so behavior must be re-verified. |

Post a comment on the PR that states the tier and the overlap list:

```
[agent:branch-updater] Updated with main (N commits). Overlap tier: A (no overlap).
Staying at pipeline:ready-for-human. CI will confirm green.
```

or

```
[agent:branch-updater] Updated with main (N commits). Overlap tier: C.
Overlapping files:
  - src/features/agents/[hooks]/useAgentsList/useAgentsList.ts
  - src/features/agents/[services]/AgentService.ts
Downgrading to pipeline:needs-test-review.
```

**Safety net**: if CI fails on a tier-A or tier-B PR after the push, the feedback-responder auto-downgrades to `pipeline:needs-feedback` per the existing orchestrator self-healing rules. False negatives get caught, and the common case stays fast.

**Forbidden files that always force tier C** (semantic-heavy files that a main merge can regress subtly even without touching the PR's own files):
- `src/[apis]/core-api/api.ts` — global API client config
- `vitest.config.ts` / `vite.config.ts` — test/build behavior
- `src/[libs]/types/**` — cross-feature types
- Any file matching `msw/handlers/**` — mock API shape

If main touched any of these, downgrade to `needs-test-review` regardless of overlap computation.

### Pre-push prettier drift (recurring class of issue)

Files that come in from main may have prettier drift relative to the branch's local prettier view (typical offenders: `toAgenticApp.test.ts`, `NavItem.test.tsx`). This causes pre-push hooks to fail.

**Correct handling** — run prettier *before* attempting the push, so the fixup is part of the branch-updater's own merge commit, not a separate `--no-verify` push:

```bash
# After `git merge origin/main`:
npx prettier --write src/ 2>&1 | tail -5
if ! git diff --quiet; then
  git add -A
  git commit --amend --no-edit   # fold the format fix into the merge commit
fi
git push origin <branch>          # CI runs on a clean branch
```

**Never use `--no-verify` to bypass the prettier hook.** If prettier reformats files, fold the fix into the merge commit (amend) so the branch's history stays clean and CI sees a single merge commit, not a merge + format fixup.

If the prettier drift is in files that aren't part of any open PR's feature area, flag it on the next cycle with a `chore: apply prettier to <file>` PR targeting main directly — root-cause the drift instead of paying the cost per branch.

## Frequency

Run every 30 minutes. Conflict detection is cheap (local git operations only). Pushes are rare — only for PRs that have passed the full pipeline.

## Rules

- NEVER force-push. Always merge main into the branch (not rebase).
- NEVER push branches in early pipeline stages — conflict detection only.
- If a PR has been `pipeline:ready-for-human` and up-to-date for over 24 hours with no human review, do not keep re-updating it on every main change — update once when it first reaches ready, then only if the owner requests it or a new main merge lands.
- Skip Dependabot PRs — they have their own update mechanism.
