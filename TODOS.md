# TODOS

Deferred work items with enough context to pick up cold. Added by /autoplan review of `docs/superpowers/plans/2026-06-09-local-only-and-agent-efficiency.md` (2026-06-09).

## CLI

### `agent-pipeline run --local` one-command wrapper

**What:** A single CLI verb that scaffolds (if needed) and runs the full local loop — init in filesystem mode, start the orchestrator, stream events — without the user touching `/pipeline init` + `/pipeline start` separately.

**Why:** Time-to-first-ticket is the trial-path metric; one command beats a three-step quickstart.

**Context:** v0.4 plan (local-only epic) ships `scripts/demo-local-loop.sh` (A10) as the stepping stone — it proves the mechanics this verb would productize. The orchestrator runs *inside* a Claude Code session, so the wrapper must either drive `claude` CLI or document that boundary.
- Pros: Best possible first-ten-minutes; demo script logic graduates into the product.
- Cons: Wraps Claude Code session startup, which the CLI doesn't own today; easy to get half-right and confuse users about where the orchestrator actually runs.

**Effort:** M
**Priority:** P2
**Depends on:** A3/A4 (backend-aware init/start) and A10 landing first.

## Backends

### GitLab/third-backend adapter inversion

**What:** Invert the backend integration: agents speak only to the queue; GitHub (and any future GitLab/Jira) becomes a sync adapter mapping labels/PRs ↔ queue states.

**Why:** Dual-backend prose in ~15 agent files doesn't scale to a third backend.

**Context:** Explicitly rejected for v0.4 (NOT-in-scope, taste decision at the /autoplan gate). **Documented trigger: the first real request for a third backend (GitLab, Bitbucket, Jira) — do the inversion then instead of adding a third prose section per agent.**
- Pros: Backend-agnostic prompts; prompts shrink; third backend = one adapter module.
- Cons: Big-bang rewrite of all GitHub-mode agent behavior; destabilizes the shipped loop; serves no current user.

**Effort:** XL
**Priority:** P4
**Depends on:** Trigger event; v0.4 local-only epic shipping (its per-agent FS sections are the second backend the inversion would absorb).

## UI / Dashboard

### Dashboard offline/local parity

**What:** Make `agent-pipeline ui` first-class in local-only mode — queue-state visualization, ticket detail/diff views, merge action parity with the A9 CLI verbs.

**Why:** The dashboard is the natural human review surface; v0.4 deliberately keeps the human surface CLI-only.

**Context:** v0.4 scopes the human surface to `agent-pipeline diff <id>` / `merge <id>` (A9). The repo has uncommitted `ui/` changes (app.js, index.html, style.css) that should land or be reconciled first. Note: `api/index.js` queueDir fix (A9) already benefits the dashboard.
- Pros: Visual review loop; lowers the bar for non-CLI users.
- Cons: The uncommitted `ui/` working-tree changes are a separate in-flight effort; doing both at once risks conflicts.

**Effort:** M
**Priority:** P3
**Depends on:** A9 shipping; resolution of the uncommitted `ui/` work.

## Ecosystem

### Community & contribution surface

**What:** CONTRIBUTING.md, issue templates, and a stated community channel (GitHub Discussions is the cheapest fit).

**Why:** The v0.4 DX review scored Community 6/10 — the only dimension below 8. Devs evaluating tools expect to see where questions get answered.

**Context:** Repo is MIT and open with runnable demo scripts; nothing tells an outside contributor how to test (`npm test`, smoke tier) or where to ask. Added by the /autoplan DX review (2026-06-09), explicitly deferred from the v0.4 plan as ecosystem work, not feature work.
- Pros: Adoption/retention; turns demo-script users into contributors; cheap (mostly markdown).
- Cons: A channel nobody monitors is worse than none — requires an ongoing attention commitment, not just files.

**Effort:** S
**Priority:** P3
**Depends on:** Nothing technical; gated on willingness to monitor the channel.

## Config

### Per-agent model pin override

**What:** `config.models.<agentName>` per-agent override on top of the v0.4 two-tier (`light`/`standard`) mapping.

**Why:** A user who wants exactly one agent (e.g. code-reviewer) on a stronger model has no surface short of editing the manifest.

**Context:** Deferred from the v0.4 DX review — B5 ships capability tiers first; measure with B0 whether anyone actually needs per-agent granularity before adding it.
- Pros: Completes the resolution chain (CLI flag > per-agent pin > tier mapping > built-in default) with one config lookup.
- Cons: More config surface to document; risk of users pinning stale model names (tiers exist precisely to avoid that).

**Effort:** S
**Priority:** P4
**Depends on:** B5 landing; B0 cost data showing a real need.

## Completed

(none yet)
