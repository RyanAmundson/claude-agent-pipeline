---
name: pipeline-init
description: Initialize the agent pipeline in the current repo — pick a backend, create labels, write config, optionally seed rules.
---

# /pipeline-init

Walk the user through setting up the agent pipeline in the current repo. Produces `.pipeline/config.json`, creates GitHub labels, and optionally seeds `.pipeline/rules/` with starter rule templates.

## Steps

### 1. Confirm the repo

Read the `origin` remote URL and parse it to `owner/repo` form:

```bash
git remote get-url origin | sed -E 's|.*[:/]([^/]+/[^/]+)\.git$|\1|'
```

Confirm with the user. If the remote isn't set or the repo isn't a GitHub repo, ask the user for the `owner/repo` slug.

### 2. Confirm the GitHub user

Read `gh api user --jq .login` to get the current authenticated user. Ask whether the pipeline should act on this user's PRs (yes 99% of the time). Save as `config.ghUser`.

### 3. Pick a backend

Ask:

> Which ticket backend do you want to use?
>
> 1. **Linear** — uses your Linear MCP integration. Tickets live in Linear. Recommended if you already use Linear.
> 2. **Filesystem** — tickets live as JSON files in `.pipeline/queue/`. Self-contained, works offline.

If the user picks Linear:

- Check whether the `linear` MCP server is connected (`/mcp` shows it). If not, instruct the user to connect it via `/mcp` first.
- Ask for `config.linear.teamId` (the Linear team key, e.g. "ENG", "PROD").
- Optionally ask for `config.linear.projectFilter`, `excludeProjects`, `excludeLabels`.

If the user picks Filesystem:

- Confirm `config.filesystem.queueDir` (default `.pipeline/queue`)
- Create the queue directory tree:
  ```bash
  mkdir -p .pipeline/queue/{needs-triage,needs-review,needs-work,in-progress,needs-test-review,needs-code-review,needs-regression-check,needs-feature-validation,needs-feedback,ready-for-human,done,needs-info,done-triage}
  ```
- Create the `.lock` file: `touch .pipeline/queue/.lock`

### 4. Detect verify commands

Suggest sensible defaults based on what's in the repo:

- `package.json` exists → suggest `["npm run type-check", "npm run lint"]` (parse scripts and confirm they exist)
- `Cargo.toml` exists → suggest `["cargo check", "cargo clippy -- -D warnings"]`
- `go.mod` exists → suggest `["go vet ./...", "gofmt -l ."]`
- `pyproject.toml` exists → suggest `["mypy .", "ruff check ."]` (if those tools are installed)

Show the suggestions, let the user accept or override. Save as `config.verify`.

### 5. Confirm worktree root

Default `.worktrees`. Confirm. Add to `.gitignore` if not already there.

### 6. Create GitHub labels

Create the pipeline state labels and provenance labels:

```bash
# Pipeline state labels
gh label create "$labelNamespace:needs-triage"        --color "FBCA04" --description "Quality issue found, needs ticket"
gh label create "$labelNamespace:needs-review"        --color "FBCA04" --description "Ticket needs review"
gh label create "$labelNamespace:needs-work"          --color "0E8A16" --description "Ticket ready to implement"
gh label create "$labelNamespace:in-progress"         --color "5319E7" --description "Worker is implementing"
gh label create "$labelNamespace:needs-test-review"   --color "FBCA04" --description "PR needs test coverage review"
gh label create "$labelNamespace:needs-code-review"   --color "FBCA04" --description "PR needs code review"
gh label create "$labelNamespace:needs-regression-check"   --color "FBCA04" --description "PR needs regression validation"
gh label create "$labelNamespace:needs-feature-validation" --color "FBCA04" --description "PR needs feature/acceptance validation"
gh label create "$labelNamespace:needs-feedback"      --color "D93F0B" --description "Review feedback to address"
gh label create "$labelNamespace:ready-for-human"     --color "0E8A16" --description "All automated checks pass"

# Agent provenance labels
for agent in scanner ticket-creator ticket-reviewer worker tester code-reviewer regression-tester feature-validator feedback-responder flex-worker orchestrator branch-updater cleanup ci-triage a11y-detector perf-detector security-detector supply-chain-detector access-control-detector injection-detector data-protection-detector data-fidelity-reviewer glossary-maintainer e2e-test-runner e2e-test-quality; do
  gh label create "$agentLabelNamespace:$agent" --color "C5DEF5" --description "Provenance: $agent"
done

gh label create "needs-info"     --color "F9D0C4" --description "Ticket lacks detail" 2>/dev/null || true
gh label create "blocked-by"     --color "FF6B6B" --description "Waiting on another PR" 2>/dev/null || true
```

Wrap each in `|| true` so re-running doesn't error on existing labels.

### 7. Write config

Write `.pipeline/config.json` with the gathered values. Validate against `config.schema.json` shipped with the plugin.

### 8. Optional: seed rules

Ask whether to seed `.pipeline/rules/` with example rule files. If yes, copy `RULES_TEMPLATE.md` and 2-3 generic example rules from the plugin's `rules/` directory.

### 9. Optional: lessons directory

Create `.pipeline/lessons/` (empty). Tell the user that agent self-audit will populate this over time.

### 10. Add to .gitignore

Add to the repo's `.gitignore`:

```
.worktrees/
.pipeline/queue/
.pipeline/lessons/
```

The user may want to commit `config.json` and `rules/` (project conventions are shared) but NOT the queue (per-machine state) or lessons (per-machine learning).

### 11. Summary

Print a summary:

```
✓ Pipeline initialized for owner/repo
  Backend: linear (team: ENG)
  Verify: npm run type-check, npm run lint
  Worktrees: .worktrees/
  Labels: 27 created (or already existed)
  Rules: .pipeline/rules/ seeded with 3 examples

Next: run `/pipeline-start` to launch the orchestrator.
```
