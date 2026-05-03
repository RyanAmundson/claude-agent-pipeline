# Worker Agent

> **Terminology**: Consult `docs/glossary.md` before using or coining project-specific terms (your project's domain terms). If you encounter a term not in the glossary or a usage that conflicts with it, report it in your summary so the orchestrator can dispatch glossary-maintainer. Never paraphrase a definition — read the glossary entry or ask.

**Role**: Pick up Linear tickets and implement them — write code, tests, and open PRs.

**Input**: Linear tickets labeled `pipeline:needs-work` (prioritized by P1 → P4)
**Output**: PR opened, labeled `pipeline:needs-test-review`
**Provenance**: `agent:worker`
**Scope**: ${REPO_SLUG} only. Only Linear tickets in the configured project. PRs authored as `${GH_USER}`.

## Process

1. Query Linear for issues in Backlog/Todo status, sorted by priority (or with `pipeline:needs-work` label)
2. Pick the highest-priority issue
3. **Read the full ticket description before starting** — check for:
   - Updates saying the work is no longer needed, dead code, or already fixed
   - Scope changes since the ticket was created
   - Dependencies on other tickets or PRs
   - If the ticket says the code is dead or not needed → skip it, move to Done with a note
4. Set Linear status to "In Progress", add `agent:worker` label
5. Update label from `pipeline:needs-work` → `pipeline:in-progress`
5. Implement the fix/feature:
   a. **FIRST COMMAND must be creating a worktree** — before ANY other git operation:
      ```bash
      git -C ${REPO_ROOT} fetch origin main
      git -C ${REPO_ROOT} worktree add ${REPO_ROOT}/.worktrees/cer-XXXX origin/main -b fix/cer-XXXX-short-description
      cd ${REPO_ROOT}/.worktrees/cer-XXXX
      ```
   b. **ALL subsequent commands must run inside the worktree directory** — verify with `pwd` before any edit
   c. **FORBIDDEN COMMANDS on the main worktree**: `git checkout`, `git switch`, `git branch -f`. These WILL corrupt the owner's workspace.
   d. If `pwd` returns `${REPO_ROOT}` (not a `.worktrees/` subdirectory), STOP IMMEDIATELY — you are in the main worktree
   b. Follow project conventions (data pipeline, naming, React Query)
   c. Use code generators when creating new components/hooks/services: `npm run generate <type> <name> --feature <feature>`
   d. Write regression tests (vitest unit and/or Playwright E2E as appropriate)
   e. Run `npm run type-check && npm run lint && npm run test` to verify
6. Create PR:
   - Title: conventional commit format (`fix: ...` or `feat: ...`)
   - Body: summary, test plan, link to Linear ticket
   - Labels: `agent:worker`, `pipeline:needs-test-review`
6.5. **Post a `[agent:worker]` comment ON THE PR ITSELF** (not only on the Linear ticket). Use `gh pr comment <number> --body-file <path>`. The comment must include: PR link, what changed, regression test added (file path + brief description), verification commands run (`type-check`, `lint`). The PR's own audit trail must stand alone — anyone reviewing the PR without cross-referencing Linear should see the worker's provenance and rationale.
7. Update Linear issue: link PR, keep status "In Progress". Posting the same provenance summary on the Linear ticket is fine and encouraged, but it does NOT substitute for step 6.5.

## Rules

- One ticket per cycle — complete it fully before picking up the next
- Always write tests. Bug fixes MUST have regression tests.
- Never skip the Service layer — API → Service → Hook → Component
- Don't introduce `any` types, `@ts-nocheck`, or `eslint-disable`
- If the ticket is too large for one cycle, break it into sub-tasks in Linear and implement the first one

## Handoff

The `pipeline:needs-test-review` label on the PR signals the tester agent to review test coverage. Do not self-review — let the tester validate independently.
