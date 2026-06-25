# Conflict Resolver Agent — Design

**Date:** 2026-06-16
**Status:** Approved, implementing
**Stage:** implementation

## Problem

`branch-updater` cheaply *detects* merge conflicts between open PR branches and `main`
(via `git merge-tree`, no checkout, no push — it runs every 30 min as a local-git-only
loop). On conflict, it labels the PR `pipeline:needs-feedback` and writes a comment that
says *"feedback-responder resolves the conflicts."*

But `feedback-responder` resolves **human PR comments** — its entire definition is about
routing the owner's review feedback to specialists. It has **no git-merge-conflict logic
at all**. So today, conflicted PRs get labeled but nothing actually resolves the merge.
The handoff points at an agent that can't do the job.

This spec adds a dedicated **`conflict-resolver`** agent that fills the gap and fixes the
broken handoff.

## Approach

Keep the detector/resolver split:

- **`branch-updater` stays the detector.** It is intentionally cheap and frequent. It
  keeps running `git merge-tree` and keeps its two-phase model. Only its *handoff target*
  changes.
- **`conflict-resolver` (new, implementation stage) is the resolver.** It does the heavy,
  stateful git work — checkout, merge `main`, resolve hunks, validate, push — that does
  not belong in `branch-updater`'s cheap loop or in `feedback-responder`'s idempotent
  human-comment loop.

Rejected alternatives:

- *Fold resolution into `branch-updater`* — pollutes the cheap 30-min detection loop with
  expensive checkouts and pushes.
- *Add merge logic to `feedback-responder`* — conflates stateful git mutation (needs
  claiming, single-writer) with idempotent human-comment handling (no claim needed).

## Trigger and routing

| Step | Today | After this change |
|------|-------|-------------------|
| Detect | `branch-updater` runs `git merge-tree` | unchanged |
| Label  | `pipeline:needs-feedback` | `pipeline:needs-conflict-resolution` |
| Handoff comment names | `feedback-responder` | `conflict-resolver` |
| Resolve | (nobody — gap) | `conflict-resolver` |
| Escalate (can't resolve) | n/a | back to `pipeline:needs-feedback` (human / `feedback-responder`) |

`conflict-resolver`'s **Identify** is also self-sufficient: it re-runs `git merge-tree` on
open PRs by `${GH_USER}` so it catches conflicted PRs even when the label is missing, and
skips bots / Dependabot (matching `branch-updater`).

Because git state is shared, the resolver **claims** a PR before working it (label
`pipeline:resolving-conflicts`, released on done or abort) so two resolvers never fight
over the same branch. This is the key difference from `feedback-responder`, which needs no
claim because its replies are idempotent.

## Resolution: tiered auto-resolve

The resolver checks out the branch and runs `git merge origin/main` (**merge, never
rebase** — matches `branch-updater`'s rule). Each conflicted hunk is classified:

| Tier | Examples | Action |
|------|----------|--------|
| **Mechanical / low-risk** | `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `CHANGELOG.md`, generated/snapshot files, import-order & formatting collisions | Regenerate, don't hand-merge: take union of `package.json` then delete + regenerate the lockfile; union changelog entries; re-run codegen; take union + `prettier --write` for format/import collisions. |
| **Semantic** | `.ts` / `.tsx` where both sides changed real logic | Read **both** sides plus the PR description and `main`'s relevant commit messages; produce a merge that preserves **both** intents; validate (see below). |
| **Ambiguous** | genuinely contradictory intent (both sides rewrote the same function differently and only one can survive) | `git merge --abort`, label `pipeline:needs-feedback`, post the conflicting hunks + the resolver's analysis + a recommended resolution, then stop. This is the human handoff. |

### Validation (critical pipeline rule)

**Agents must NOT run the test suite** (orphaned-process risk — enforced pipeline-wide).
After resolving, the resolver validates with:

1. `git diff --check` — no leftover conflict markers.
2. The repo's configured `verify` commands only (default `npm run type-check`,
   `npm run lint`) from `.pipeline/config.json`.

Deeper (test) verification is **routed**, not run — see below. This is exactly why the
overlap-tier re-verification model exists.

It reuses `branch-updater`'s prettier rule: if prettier reformats files, fold the fixup
into the merge commit (`git commit --amend --no-edit`), **never `--no-verify`**.

If validation keeps failing after a bounded number of attempts, abort and escalate
(ambiguous tier) rather than pushing a broken merge.

## Push and re-verification routing

After a successful resolve + push, decide re-verification by **reusing
`branch-updater`'s existing overlap tiers** (A/B/C) and its forbidden-files list —
identical computation, so behavior stays consistent:

- Compare the set of files the resolution touched against the files the PR owns.
- **Tier A (no overlap):** keep `pipeline:ready-for-human`; CI confirms green.
- **Tier B (config/infra overlap only):** keep `ready-for-human`; downgrade only if CI
  goes red.
- **Tier C (same `src/**` files, or any forbidden file):** downgrade to
  `pipeline:needs-test-review` → `tester` → `code-reviewer`.

Post the same tier-comment format `branch-updater` uses.

## Safety rails

- Never force-push. Never rebase (merge only).
- Never `-X ours` / `-X theirs` on **source** files — that silently discards one side's
  logic. Side-selection is allowed only for regenerable artifacts (lockfiles, snapshots).
- Always `git merge --abort` cleanly on escalation — never push a half-merged tree.
- Bounded retries on validation; escalate instead of looping.
- Only open PRs authored by `${GH_USER}`; skip bots / Dependabot.

## Files changed

| File | Change |
|------|--------|
| `agents/conflict-resolver.md` | **New.** Frontmatter style matching `feedback-responder`: `stage: implementation`, `consumes: [conflict-task]`, `produces: [pr]`, `model: sonnet`. Full process spec. |
| `manifest.json` | Add `conflict-resolver` entry: `{ "stage": "implementation", "requires": ["github"] }`. |
| `agents/branch-updater.md` | Rewrite the "Conflict Resolution Handoff" section + the `needs-feedback`/conflict rows of the Phase-2 table to point at `conflict-resolver` and `pipeline:needs-conflict-resolution`. |
| `agents/ORCHESTRATION.md` | Hand-edit the mermaid: add `ConflictResolver` node in Implementation; edges `BranchUpdater --> ConflictResolver : has-conflicts`, `ConflictResolver --> Art_pr : resolved`, `ConflictResolver --> FeedbackResponder : needs-feedback`, and `[*] --> ConflictResolver : has-conflicts`. |

### Artifact taxonomy

- `conflict-task` is a new artifact whose sole producer is `branch-updater` (it has no
  frontmatter today, so the generated diagram represents this edge by hand; the
  single-producer invariant holds).
- `conflict-resolver` produces `pr` — the allowlisted fan-in into Quality. No new
  multi-producer artifact is introduced.

## Backend

- **GitHub: required.** PR branches are the entire subject of this agent, so `manifest`
  lists `requires: ["github"]`.
- **Filesystem backend:** there are no PRs, but branches still conflict. The agent mirrors
  the same flow against the queue — resolve on the branch, record a queue comment, and
  transition ticket state (`needs-conflict-resolution` → resolved, or → `needs-feedback`
  on escalation) instead of editing PR labels.

## Tunable knobs (defaults chosen)

- **Model:** `sonnet` to match sibling implementation agents. Safety comes from
  type-check/lint + routing tests to `tester`, not raw model strength. `opus` is a
  reasonable upgrade for the semantic tier if false merges show up.
- **Label name:** `pipeline:needs-conflict-resolution`.

## Out of scope

- Retrofitting `pipeline:` frontmatter onto `branch-updater` (it works without it today).
- Auto-merging the PR after resolution — humans still merge.
- A diagram generator change — the mermaid is hand-edited per the doc's own allowance.
