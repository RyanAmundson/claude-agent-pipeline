<!-- /autoplan restore point: main-autoplan-restore-20260609-232412.md (reviewer's local gstack artifact store, not in this repo) -->
# Local-Only Standalone Mode + Agent Efficiency Pass

**Status:** approved — /autoplan review complete, all gates passed (2026-06-10)
**Branch:** main
**Directive:** "Improve this agent team to better suit local only standalone usability. Improve agents that operate inefficiently."

## Problem

claude-agent-pipeline v0.3.0 shipped a filesystem-backend review loop (worker → tester → code-reviewer → feedback-responder run GitHub-free). But "local-only standalone" — a user with no `gh`, no Linear, no remote — still cannot run the full pipeline:

1. **Intake is dead in filesystem mode.** `orchestrator.md:276` explicitly carves out ticket-creator/ticket-reviewer as Linear-coupled "future work". Detector findings written to `.pipeline/findings/` never become tickets; the loop only works if a human hand-drops JSON into `needs-work/`.
2. **Init/start assume GitHub.** `pipeline-init.md` unconditionally creates ~16 GitHub labels (lines 65-87) and requires `owner/repo` + `ghUser`. `pipeline-start.md:14` hard-requires `gh auth status` to pass before the orchestrator starts.
3. **Lifecycle agents have no FS path.** `cleanup` (worktree/branch removal keyed off `gh pr list --state merged`), `branch-updater` (merge-freshness keyed off PR labels), and `ci-triage` (GitHub Actions only) silently fail or error in a remote-free repo.
4. **Install filtering is backend-blind.** `bin/cli.js` filters agents by dep detection (`gh` on PATH) but a machine *with* gh installed and a *filesystem-backend* project still installs GitHub-only agents that can't run; a machine without gh drops `worker`/`orchestrator` which actually do have FS paths.

**Framing (adopted from CEO review):** local-only is not just a niche persona — it is every prospective user's first ten minutes. `npx claude-agent-pipeline install . && /pipeline init` with zero labels, zero auth, zero Linear is the trial path. The success metric is **time-to-first-ticket-flowing**, not just "e2e passes with gh shimmed." Note: "local-only" means no GitHub/Linear/remote; it still requires Anthropic API access — docs must not imply offline/air-gapped.

Separately, the agent team operates inefficiently:

5. **320-line protocol file duplicated verbatim** in `agents/agent-work-protocol.md` and `rules/agent-work-protocol.md` (confirmed byte-identical) — both installed, both loaded, ~1.2k wasted tokens per dispatch, two places to maintain.
6. **security-detector dispatched every cycle unconditionally** (`orchestrator.md:163`) even when no code changed since the last scan — the most expensive detector burning idle cycles.
7. **Detector overlap**: justification-detector's triggers re-scan layer violations that pipeline-violation-detector owns.
8. **Prompt bloat**: e2e-test-quality.md (484 lines) and e2e-test-runner.md (313 lines) carry project-policy boilerplate (deterministic waits, process management) that belongs in shared rules, inflating every dispatch.
9. **No per-agent model hints**: `dispatch.js` supports `--model` but manifest.json has no per-agent model field, so mechanical agents (cleanup, branch-updater, scanner triage) run on the session default model.

## Premises

- P-A: Local-only (no gh, no Linear, no remote) is a first-class install target, not a degraded fallback. The filesystem backend is the vehicle.
- P-B: The existing `.pipeline/queue/<state>/*.json` + `queue-*.sh` primitives are sound and should be extended, not replaced.
- P-C: Agents that are inherently remote-coupled (linear-issue-orchestrator, ci-triage, glossary-maintainer, technical-docs-manager, flex-worker) should be cleanly excluded in local-only installs rather than half-ported.
- P-D: Efficiency fixes must not weaken the pipeline's fail-safe guarantees (e.g., the deliberate "no timestamp cutoff" rule for human-comment scans at orchestrator.md:277).
- P-E: Prompt-file size directly costs tokens on every dispatch; factoring shared policy into rules/ is net-positive despite one more indirection.

## Scope

### Epic A — Local-only standalone mode

- **A1. Filesystem intake.** Add filesystem-backend sections to `ticket-creator.md` (read `.pipeline/findings/*.md` → create **`needs-review/<id>.json`** via a new `queue-create.sh` primitive) and `ticket-reviewer.md` (review **`needs-review/`** → approve to `needs-work/` or reject to `done/` with a comment and `rejected: true` field — no new state). State wiring corrected by eng review: queue/README.md defines `needs-triage/` = raw findings awaiting ticket creation and `needs-review/` = tickets awaiting validation, and orchestrator.md's dispatch table maps `needs-triage → ticket-creator`, `needs-review → ticket-reviewer` — creator *output* must land in `needs-review/`, otherwise creator-output re-dispatches the creator (self-loop) and `needs-review/` goes dead. A1 explicitly reconciles the intake-state rows across `orchestrator.md`, `queue/README.md`, and `pipeline-init.md`'s scaffolded dirs (including the existing `done-triage/` dir). **Dispatch trigger (explicit, to kill the remaining ambiguity):** in FS mode the orchestrator dispatches ticket-creator when `.pipeline/findings/` contains unconsumed `*.md` files (the "needs-triage" concept maps to raw findings on disk, not ticket JSON in a `needs-triage/` queue dir), and dispatches ticket-reviewer when `needs-review/` is non-empty — the updated dispatch table states both rows. Update `orchestrator.md:276` to dispatch them in FS mode; delete the "future work" carve-out. **Dedupe key (eng):** the detector fingerprint (`<agent>:<issue-class>:<file>:<line>` — detectors already emit it and check `.pipeline/findings/filed/`, see security-detector.md "Dedup via Fingerprint"). Ticket-creator stores it on the ticket (`source.fingerprint`) and maintains `.pipeline/findings/filed/` exactly as detectors expect — ticket-side and detector-side dedupe stay ONE system. A `rejected: true` ticket suppresses re-ticketing of the same fingerprint via `filed/` (which survives `done/` pruning) — **except critical-severity secret findings, which security-detector.md's shipped policy always re-files; the suppression honors that carve-out** (a human who rejects a true critical must remediate or downgrade severity, not be silently un-warned). **Redaction contract (adversarial review):** security-detector's finding template embeds code snippets, so secret *values* can transit findings → ticket JSON → comments; A1 requires detector and ticket-creator prompts to mask matched secret values (first 4 chars + `…`) in finding bodies and ticket fields — location + fingerprint identify the secret, the value itself never lands in queue files. **Severity contract (eng):** findings carry structured frontmatter (`severity`, `source`, `file`, `line`) — A1 updates detector prompts to emit it; the `minSeverity` gate reads frontmatter, never prose. **Noise gate:** `config.filesystem.maxOpenTickets` (default 20) counts **all non-terminal states** (everything except `done/`), so intake can't flood a saturated downstream; enforced atomically inside `queue-create.sh` (count + create under the queue lock — a prompt-level count is a read-then-create race with up-to-3 concurrent creators), with the prompt rule kept as a hint only. Severity below `config.filesystem.minSeverity` (default `medium`) is skipped with a log line, not a ticket. **Error-message contract (DX — both voices; applies to every user-facing refusal/skip in A1/A2/A9/A12):** problem + cause + exact fix, naming the config key or command that resolves it — e.g. `Skipped finding: 20 open tickets >= filesystem.maxOpenTickets (20). Resolve tickets or raise the cap in .pipeline/config.json.`; `Cannot merge fs-123: current branch is feature/x, ticket base is main. Run: git switch main`. "Log line" with no pointer is not rescue — it's silence with extra steps.
- **A2. `queue-create.sh` primitive.** New queue script: create a ticket JSON (id, title, description, priority, source agent + fingerprint, timestamps) atomically in a target state dir, enforcing the `maxOpenTickets` cap under the queue lock (see A1). Used by ticket-creator and human CLI (`agent-pipeline ticket new` — note `ticket <id>` already exists at cli.js:448, so the parser gains an explicit `new` subcommand branch before the id lookup; `new` is reserved and never a valid ticket id). **CLI signature (DX):** `agent-pipeline ticket new "<title>" [--body <text>] [--priority low|medium|high] [--state needs-work]` — title positional, body optional, state defaults to `needs-work` (a human-created ticket is pre-triaged); bare `ticket new` prints usage, never a malformed ticket. **Priority mapping (adversarial review):** queue tickets store *numeric* priority (queue-list.sh sorts numerically; cli.js displays `P${priority}`), so the flag maps `high→1, medium→2, low→3` (default 2) at create time — queue-create.sh never stores the string, or sorting and display degrade (`Pmedium`). **Lock parity (eng):** `queue-claim.sh` currently takes no lock (mv only) while `queue-update.sh` locks `$QUEUE_DIR/.lock` — a claim racing an update can resurrect the ticket in its old state dir (jq reads → mv claims → `_apply`'s mv recreates). queue-claim.sh acquires the same lock (flock with mkdir fallback, same pattern as queue-update.sh) — **and so does `queue-stale.sh` (adversarial review), which also rewrites-and-moves tickets lock-free today; lock parity means every queue mutator, not just claim**. Plus tests (create atomicity, cap-at-boundary, claim/update interleave).
- **A3. Backend-aware init.** `pipeline-init.md`: when backend=filesystem, skip GitHub label creation entirely, make `repo`/`ghUser` optional, scaffold the queue dirs, and print a local-only quickstart. Detect "no remote + no gh" and pre-select filesystem backend. **Fast path (DX — both voices):** the current wizard is 11 steps with ~6 interactive asks (verify commands, worktree root, rules seeding, lessons dir, gitignore…) — heavy for "every prospective user's first ten minutes." FS-mode init offers accept-all-defaults up front ("press enter to accept defaults for everything else") so a local trial is one confirmation, with each default named in the summary; the full wizard remains available by answering the prompt.
- **A4. Backend-aware start.** `pipeline-start.md`: gh auth and label checks only when the backend needs them; FS preflight = queue dirs + valid config.json.
- **A5. FS paths for lifecycle agents.** `cleanup.md`: ticket in `done/` is the *candidate* signal — before deleting anything, cleanup verifies actual integration with `git merge-base --is-ancestor <ticket.branch> <ticket.base>` (or `git branch --merged`); **squash-merge fallback (eng; bounded by adversarial review):** ancestor checks fail under squash merges (cleanup.md:112 already documents this), so on ancestor-check failure cleanup falls back to patch-id equivalence (`git cherry <base> <branch>` — all commits equivalent → treat as merged). **Known limit:** patch-id equivalence only matches when the branch's commits map 1:1 to upstream patches — a squash of N>1 commits produces one combined patch that matches none of them, so multi-commit squash-merged branches fall through to the refusal path (once-only warning, human deletes). That direction is deliberately safe: the guard must never loosen to make the fallback "work" for multi-commit squashes. A `done/` ticket whose branch has genuinely unmerged commits gets a warning comment and is left alone (task status ≠ repo integration — adopted from CEO review); the warning is **once-only** (skip if a prior cleanup warning comment exists on the ticket — no per-cycle comment spam). `branch-updater.md`: merge-freshness via local `git merge-tree` against `ticket.base`; **state routing (eng):** on conflict, move the ticket from `ready-for-human/` back to `needs-feedback/` with a conflict-summary comment — mirroring the GitHub-mode routing in branch-updater.md, so a conflicted ticket is never left sitting mergeable in `ready-for-human/` with only a comment. Clean result → comment only. `ci-triage`: explicitly not dispatched in FS mode (orchestrator dispatch table note).
- **A6. Backend capability in manifest + installer.** Add `backends: ["linear","filesystem"]` (or single-valued) per agent in manifest.json — values match the `config.backend` enum (`linear|filesystem`, config.schema.json:19); "github" is a *dependency*, not a backend, and conflating them was caught by both eng voices. **Filter semantics (eng — this was the plan's load-bearing bug):** a plain `filter = requires ∧ backends` does NOT fix problem #4 — the seven FS-loop agents (orchestrator, worker, tester, code-reviewer, feedback-responder, cleanup, branch-updater) all carry `requires: ["github"]` today, so a gh-less machine would still drop them. The rule is: **in a `--backend filesystem` install, the `github` (and `linear`) dep is waived for any agent whose `backends` includes `filesystem`** — those agents' FS sections don't shell out to `gh`. Agents without filesystem support are excluded outright. `bin/cli.js install --backend filesystem` (also inferred from an existing `.pipeline/config.json`) applies this; `list-agents`/`detect` show backend support. **Signal hygiene (DX — both voices):** `--without github` is NOT a backend signal — it conflates dependency with backend, the exact category error fixed in the manifest; precedence is explicit flag > existing config > interactive prompt, and the installer always echoes the backend it resolved ("Installing for backend: filesystem (from .pipeline/config.json)"). Acceptance: `install --backend filesystem --dry-run` on a PATH without `gh` lists the full FS-capable set including worker and orchestrator.
- **A7. Docs (expanded by DX review — both voices flagged A7 as one line carrying the trial path).** (1) **README local quickstart at the top** (above the CLI reference, not after it): "Try locally — no GitHub or Linear" with prereqs (Node 18+, git repo, Claude Code, Anthropic access — local-only ≠ no-Claude), one copy-paste block whose first ticket is seeded *deterministically* via `agent-pipeline ticket new` (detectors are the second act, not the hello world), expected output after each command, an observability step (`agent-pipeline status` / `events` — the surface where cap/severity skip log lines actually appear), "what just happened", common failures, and "next: review, diff, merge". (2) **Rewrite the contradicting sections:** README:186 currently calls filesystem the "offline fallback" and the Configuration "Minimum" example hardcodes `repo`/`ghUser`/`linear` — both contradict the trial-path framing; add the minimal FS config example (valid per A11). (3) **New-verb doc parity:** `docs/API.md`, the CLI `HELP` string (bin/cli.js:27), and the README CLI table all gain `ticket new`, `diff`, `merge`, `reopen`, `doctor` — acceptance check: every verb appears in `--help` (README already omits existing `status`/`ticket`/`comment` verbs; drift is a demonstrated failure mode here). (4) Slash-command naming consistency (`/pipeline init` vs `/pipeline-init` are currently mixed in README/commands). (5) queue/README.md updates for the new primitive + intake states + the documented reopen procedure + the B2 force-scan escape hatch (delete `.pipeline/findings/.security-scan.json` — the full marker path per B2's spec — → fail-open full scan). (6) Install output prints the symlink-mode warning ("npm update ships behavior changes to this project immediately"). (7) CHANGELOG with a v0.3→v0.4 migration note (new config keys, new queue states, new verbs) — **and the release version bumps themselves: package.json (0.3.0) and manifest.json (0.2.0) both move to 0.4.0 (plugin.json checked for parity); rollout (CEO §9) claims v0.4.0 ships, so the bumps are an explicit deliverable, not an assumed side effect**.
- **A8. E2E.** Extend `test/e2e` fixture, two tiers (adopted from CEO review — tier was underspecified): **smoke tier** (no model spend) tests the mechanics with scripted stand-ins — queue-create atomicity/collision + cap-at-boundary, queue-claim/queue-update interleave (lock parity, A2), init/start FS preflight, intake state transitions (creator output lands in `needs-review/`, reviewer approves/rejects), fingerprint dedupe (a rejected finding is NOT re-ticketed on the next sweep), cleanup merge-verification refusal path + squash-merge fallback + once-only warning, `diff`/`merge` verb behavior on clean/conflicting/dirty trees **and wrong-checked-out-branch refusal**, B2 fail-open AND B2 skip-when-unchanged (a regression that always scans must fail the suite, not pass it), **version-skew** (v0.4 prompts against a v0.3 config missing `models`/`maxOpenTickets`/`minSeverity` — all defaults hold), **init re-run backend switch** (existing GitHub-backend project re-inits to filesystem: queue scaffolded, existing keys preserved, no label calls); **live tier** (joins the existing `CAP_E2E_LIVE=1` suite) runs the full seeded loop — finding → ticket-creator → ticket-reviewer → worker → tester → code-reviewer → ready-for-human → `agent-pipeline merge` → done → cleanup — with `gh` shimmed off PATH throughout both tiers.
- **A9. Human review/merge surface (added by CEO review — both voices flagged the loop dead-ends at `ready-for-human/`).** New CLI verbs: `agent-pipeline diff <id>` (shows `git diff <ticket.base>...<ticket.branch>` for a ticket) and `agent-pipeline merge <id>` (merges `ticket.branch` into `ticket.base`, moves ticket to `done/`, appends a provenance comment). **Merge safety (eng — both voices):** (1) `git merge` merges into HEAD, not into `ticket.base` — the verb **refuses unless the currently checked-out branch equals `ticket.base`** ("checkout <base> first"), otherwise it would silently merge into whatever branch the user happens to be on; (2) preflight uses `git merge-tree` (read-only) — NOT `git merge --no-commit --no-ff`, which mutates the index/worktree and leaves merge state; on predicted conflict, print the conflict file list and leave the ticket in `ready-for-human/`; (3) clean working tree verified before any merge; (4) **ref hygiene:** ticket `branch`/`base` are agent-written strings — validate with `git check-ref-format --branch` and pass refs after `--` separators in every git invocation, so a value starting with `-` can never be parsed as a git option. **API path (eng):** `api/index.js:39` hardcodes `.pipeline/queue` while `bin/cli.js:365` resolves `config.filesystem.queueDir` — since these verbs (and `status --json`, which the FS orchestrator reads) go through the API, A9 includes the one-function fix to resolve `queueDir` from config in api/index.js. **Conflict recovery (DX):** the conflict message names the exact recovery sequence ("resolve manually: `git switch <base> && git merge <branch>`, fix conflicts, commit, then re-run `agent-pipeline merge <id>` — the re-run detects the branch is already merged and idempotently moves the ticket to done/"); A8 asserts the manual-merge-then-re-run path. **Reopen escape hatch (DX):** `agent-pipeline ticket reopen <id>` moves a `done/` ticket back to `needs-work/` with a provenance comment (one mv via the queue scripts) — without it the plan's stated reopen mechanism is "move the file by hand", reintroducing exactly the hand-editing A9 exists to eliminate. Closes the loop without hand-editing queue JSON. Dashboard work stays out of scope.
- **A12. `agent-pipeline doctor` (added by DX review — Codex voice; trial-path triage).** New verb building on `detect`'s machinery but checking *state*, not just deps: config validates against the schema, queue dirs exist, installed agent set matches the configured backend, no stale `in-progress` runs, and (FS mode) `gh`-free really means gh-free (no agent in the install requires it). Every failed check prints problem + cause + exact fix per the error-message contract. `detect` stays dependency-focused; `doctor` is the "why isn't my pipeline working" surface.
- **A10. Local demo script.** `scripts/demo-local-loop.sh` mirroring the existing demo scripts: scaffolds a temp repo, runs init in filesystem mode, seeds a finding, and walks the full loop. Doubles as living documentation for A7.
- **A11. Config schema (added by eng review — schema changes were implied but unscoped).** `config.schema.json`: make `repo`/`ghUser` conditionally required (only when backend ≠ filesystem — today's flat `required: ["repo","ghUser","backend"]` at line 6 fails A3's gh-less init, and pipeline-start validates against the schema), add `filesystem.maxOpenTickets`, `filesystem.minSeverity`, and `models` (`{light, standard}`) properties with defaults documented. **Versioned config (DX — Codex voice):** add `configVersion` (init writes it; absent = v0.3 shape); when a pre-versioned config is detected, tools print a one-line non-blocking deprecation note pointing at the CHANGELOG migration entry — "upgrade without fear" needs the tool to say what changed, not just survive it. Smoke test validates a minimal filesystem-only config.

### Epic B — Agent efficiency

- **B0. Measure first (added by CEO review — both voices flagged Epic B as inspection-driven).** Before any prompt surgery: (1) pull per-agent `run.cost` from `.pipeline/runs/completed/` to rank actual spend — **telemetry caveat (eng):** run.json stores only `{usd, durationMs}` (dispatch.js:212); input-token counts live only in raw result events in `logs/<runId>.events.jsonl`, so B0 parses the events files, and if `runs/completed/` is sparse (see point 3) falls back to instrumented test dispatches; (2) empirically confirm what loads into a dispatched agent's context — does `claude --agent` inject `.claude/rules/*` into subagents, or only the agent file? B1/B4's placement decisions depend on the answer; (3) **determine the production dispatch path (eng — both voices):** orchestrator.md:56 spawns agents as one-shot *Task-tool background agents*, which never touch `runner/dispatch.js` — B0 confirms which path (Task tool vs `agent-pipeline run`) dominates in practice, because B5's implementation layer and B0's own telemetry source both depend on the answer. If orchestrator cycle frequency dominates spend, B6 generalizes and B4 may be cut.
- **B1. De-duplicate the work protocol.** Single source of truth at `rules/agent-work-protocol.md`; `agents/agent-work-protocol.md` deleted; manifest/installer references updated; agents reference the rule path. Placement (rule vs. per-agent excerpt) follows B0's context-load finding.
- **B2. Conditional security-detector.** Orchestrator dispatch rule: run security-detector when commits/merges landed since its last scan marker, or when a prior critical finding is unremediated; **skip the dispatch otherwise** (the earlier "join the round-robin" wording contradicted the skip semantics — a skipped detector is not dispatched at all that cycle). **Marker spec (eng — was unspecified):** `.pipeline/findings/.security-scan.json` storing `{commit: <scanned HEAD sha>, at: <iso timestamp>}`, written by the detector at scan completion; "code changed" = `HEAD sha ≠ marker.commit`. **Reconciliation with the shipped detector policy (adversarial review):** security-detector.md mandates a daily minimum scan even with no code changes ("fingerprints change over time as context shifts") — B2 preserves it as a marker max-age: skip requires `HEAD sha == marker.commit` AND `marker.at` younger than 24h; a stale-but-matching marker still scans. E10 updates security-detector.md and orchestrator.md together so the two files state one policy. **Fail-open (P-D):** marker absent, unparseable, or pruned → scan. The failure mode must never be "silently stop scanning." Smoke-tier e2e asserts BOTH paths: fail-open (corrupt marker → scan) and skip (unchanged sha + fresh marker → no dispatch) — testing only fail-open lets an always-scan regression silently erase the savings.
- **B3. Detector dedup.** Remove layer-violation triggers from `justification-detector.md` (defer to pipeline-violation-detector); tighten its scope to missing-justification detection only.
- **B4. Prompt diet.** Extract shared E2E policy from `e2e-test-quality.md`/`e2e-test-runner.md` into the **playwright-gated preset rules** (not a globally-loaded rule — if rules load into every dispatch, globalizing e2e policy taxes non-e2e agents; B0 verifies this first). Cut each agent file to its unique workflow. Target: e2e-test-quality ≤ 250 lines, e2e-test-runner ≤ 200, no behavior change. Verification measures token deltas on changed agents AND on an unchanged agent (worker) to catch net-negative globalization.
- **B5. Per-agent model tiers.** `modelTier: "light" | "standard"` per agent in manifest.json — capability tiers, not hardcoded model names (model names age; tiers don't; `standard` over `default` because "the default tier is `default`" reads circular in help text — DX). Tier→model mapping lives in `.pipeline/config.json` (`config.models.light`, `config.models.standard`) with sensible defaults. **Two dispatch layers, one source of truth (eng — both voices flagged that dispatch.js alone misses production):** the orchestrator dispatches via Task-tool background agents (orchestrator.md:56), which never pass through `runner/dispatch.js` — so (a) `runner/dispatch.js` resolves manifest tier → config mapping when `--model` isn't explicitly passed (CLI path), AND (b) the orchestrator's dispatch instructions gain a rule to look up the agent's tier and pass the resolved model when spawning subagents (the dominant production path, per B0 point 3). Both layers read the same manifest field + config mapping. **Safety rule (adopted from CEO review):** agents that delete worktrees/branches or rewrite branch state (cleanup, branch-updater) stay on `standard` tier — `light` is reserved for read-only/mechanical agents (scanner, context-mapper, glossary-maintainer).
- **B6. Orchestrator snapshot efficiency (GitHub mode).** Batch the per-PR comment fetches (single `gh api graphql` query or `gh pr list --json comments`) instead of 3 calls per PR per cycle. Keep the no-timestamp-cutoff semantics (P-D) — fewer calls, same coverage.
- **B7. FS comment-scan scoping (added by eng review).** orchestrator.md:277's FS rule reads `comments[]` on "every ticket in every state" with no cutoff — and A1/A9 now route every rejected and merged ticket into `done/` forever, so the per-cycle scan grows without bound over a terminal archive, directly fighting Epic B. Scope the unresolved-human-comment scan to **non-terminal states** (everything except `done/`). This is a state-based exclusion, not a timestamp cutoff — P-D's "never miss a human comment on an active ticket" invariant is preserved; `done/` is the archive, and reopening a done ticket is an explicit human action (via `agent-pipeline ticket reopen <id>`, A9), not a comment.

## NOT in scope

- Replacing the filesystem queue with a database or daemon.
- **Backend adapter inversion** (agents speak only queue; GitHub becomes a sync adapter). Explicit decision, not an accident: prose-conditional backend sections are acceptable for exactly **two** backends. The first request for a third backend (GitLab, Bitbucket, Jira) is the documented trigger to do the inversion instead of adding a third prose section to ~15 agent files. (Taste decision — surfaced at the final gate.)
- Porting linear-issue-orchestrator, glossary-maintainer, technical-docs-manager, or flex-worker to filesystem mode (excluded in local-only installs per P-C, confirmed at premise gate).
- UI/dashboard changes (the uncommitted `ui/` working-tree changes are a separate effort). The human surface for local mode is the A9 CLI verbs, not the dashboard.
- Multi-repo or multi-project orchestration.
- Changing the state-machine shape (states, handoffs) — same loop, fewer remote dependencies. (Codex's "single-process local runner" reframe noted; overridden by premise gate P-B.)
- Single-command `agent-pipeline run --local` wrapper — deferred to TODOS; A10's demo script is the stepping stone.

## What already exists (leverage)

- `queue-claim.sh`, `queue-update.sh`, `queue-comment.sh` (with `--verdict`), `queue-stale.sh`, `queue-list.sh` — mature, tested (v0.3.0). Concurrency caveat (adversarial review): only `queue-update.sh` takes the lock today; `queue-claim.sh` and `queue-stale.sh` mutate lock-free — A2's lock parity closes both.
- Filesystem sections already in worker.md, tester.md, code-reviewer.md, feedback-responder.md, orchestrator.md (review loop only).
- `bin/cli.js` dep-detection + filtering machinery (`agentSatisfied`) — extend, don't rebuild.
- `runner/dispatch.js` already accepts a model option — only the per-agent default is missing.
- Detectors already write to `.pipeline/findings/` with no remote dependency — intake is the only missing link.
- E2E harness + seeded fixture under `test/fixtures/full-pipeline/`.
- Detector fingerprint dedupe protocol (`<agent>:<issue-class>:<file>:<line>` + `.pipeline/findings/filed/`, see security-detector.md) — A1's ticket dedupe reuses it instead of inventing a second system (added by eng review).

## Verification

- `npm test` + `npm run test:e2e:smoke` green.
- New A8 local-loop e2e passes with gh shimmed off PATH (smoke tier mechanics; live tier full loop under `CAP_E2E_LIVE=1`).
- `agent-pipeline install --backend filesystem --dry-run` lists exactly the FS-capable agent set.
- Token check (B0 baseline → after): dispatch input size for e2e-test-quality, e2e-test-runner, AND an unchanged agent (worker) measured before/after B1/B4 — changed agents shrink, unchanged agents do not grow.
- **Time-to-first-ticket:** from `npx claude-agent-pipeline install .` in a fresh remote-less repo to a ticket flowing through `needs-work/`, following only the README quickstart — target under 10 minutes, demo script (A10) proves it mechanically. **Hello-world checkpoint (DX):** the quickstart's deterministic path (install → init fast-path → `ticket new`) puts a visible first ticket in the queue in **under 5 minutes** — the detector-driven organic path is explicitly the second act, so the TTFT target never depends on detector nondeterminism or model spend.
- B2 both ways: smoke test asserts security-detector is dispatched when its scan marker is missing/corrupt (fail-open) AND skipped when the marker sha matches HEAD and the marker is fresh (<24h — the savings actually exist; a stale marker scans per the daily-minimum policy).
- Cleanup safety: smoke test asserts cleanup refuses to delete a branch with unmerged commits even when its ticket sits in `done/`; that a single-commit squash-merged branch is recognized via the patch-id fallback; and that a multi-commit squash-merged branch is refused with the once-only warning (never deleted) — the fallback's known limit must fail safe, not loosen the guard.
- Merge safety: smoke test asserts `agent-pipeline merge` refuses when the checked-out branch ≠ `ticket.base`, and that a `branch` value starting with `-` is rejected, not passed to git.
- Intake wiring: smoke test asserts ticket-creator output lands in `needs-review/` (not `needs-triage/`) and a rejected fingerprint is not re-ticketed on the next sweep.
- Doctor triage (A12): smoke test asserts `agent-pipeline doctor` on a broken fixture (missing queue dir, v0.3-shape config, backend/agent-set mismatch) prints contract-compliant findings (problem + cause + exact fix).

---

# CEO Review (autoplan Phase 1 — SELECTIVE EXPANSION)

## Step 0A — Premise Challenge
P-A through P-E evaluated individually. Both outside voices independently challenged P-A (persona asserted without demand evidence) and the framing was sharpened in response: local-only re-framed as the universal trial path (time-to-first-ticket metric added) rather than a niche no-remote persona. P-B challenged by Codex (queue mechanics may be the wrong product shape locally) — overridden at the user-confirmed premise gate. P-E challenged by Claude voice (token claim assumes both protocol copies load per dispatch — unverified) — resolved by adding B0 (measure first). **Gate result: user confirmed all five premises (D3).**

## Step 0B — Existing Code Leverage Map
| Sub-problem | Existing code | Reused? |
|---|---|---|
| Atomic state transitions | `queue/queue-claim.sh` (mv-based) | Yes — A1/A9 build on it |
| Ticket mutation | `queue/queue-update.sh` (flock-optional) | Yes |
| Comments + verdicts | `queue/queue-comment.sh --verdict` | Yes — tester/code-reviewer FS paths already use it |
| Queue snapshot | `agent-pipeline status` (cli.js:341,414) — verified to exist | Yes — orchestrator FS section references it |
| Dispatch + model flag | `runner/dispatch.js` (`opts.model` → `--model`, line 72) | Yes — B5 only adds per-agent default resolution |
| Dep filtering | `agentSatisfied()` in bin/cli.js | Yes — A6 extends with `backends` axis |
| Run cost telemetry | `.pipeline/runs/completed/` (`run.cost`) | Yes — B0 reads it; nothing new built |
| Demo scripting | `scripts/demo-run-loop.sh` | Yes — A10 mirrors it |
| Ticket creation | **gap** — no `queue-create.sh`; only agents hand-roll JSON | A2 fills the one missing primitive |

Nothing in scope rebuilds an existing capability.

## Step 0C — Dream State
```
CURRENT STATE                      THIS PLAN                         12-MONTH IDEAL
Review loop runs GitHub-free;      Full loop local: intake →         One-command trusted local
intake/lifecycle dead locally; --> implement → review → merge,  -->  autonomous loop; backend
init demands gh; prompts carry     zero-auth init, backend-aware     adapters (GitHub/GitLab) sync
duplicated boilerplate; every      install, measured prompt diet,    a queue-native pipeline; cost-
cycle runs the priciest detector   tiered models, conditional scans  ranked dispatch; dashboard parity
```
Delta: this plan moves directly toward the ideal. The one ideal-state item it deliberately does not start is the adapter inversion (documented trigger: third backend request).

## Step 0C-bis — Implementation Alternatives
```
APPROACH A: In-place port (chosen)
  Summary: Extend the v0.3.0 pattern — per-agent FS sections + backend-aware installer + new queue-create primitive.
  Effort: M (human ~3-4 days / CC ~2-3h)   Risk: Low   Completeness: 8/10
  Pros: smallest diff per P-B; pattern proven by shipped review loop; each agent independently testable
  Cons: dual-backend prose in ~12 files; third backend would force rework (trigger documented)
  Reuses: all five queue scripts, agentSatisfied(), dispatch.js model flag

APPROACH B: Queue-as-interface adapter inversion
  Summary: Agents speak only queue; GitHub becomes a sync adapter (labels/PRs ↔ queue states).
  Effort: XL (human ~3 wks / CC ~2-3 days)   Risk: Med-High   Completeness: 10/10 long-term
  Pros: backend-agnostic prompts, prompts shrink, third backend = one adapter
  Cons: big-bang rewrite of all GitHub-mode agent behavior; destabilizes the shipped loop; serves a backend nobody has requested yet

APPROACH C: Minimal viable (init/start + ticket-creator only)
  Summary: Fix the loudest breakages, skip lifecycle + installer awareness.
  Effort: S   Risk: Low   Completeness: 4/10
  Cons: detectors still dead-end; cleanup still errors; install still misleads
RECOMMENDATION: A — completeness 8/10 at low risk, P-B confirmed at gate; A-vs-B is the phase's taste decision (surfaced at final gate with B's trigger condition recorded).
```

## Step 0D — Selective Expansion: cherry-pick decisions (auto-decided per P2 blast-radius rule)
| Candidate | Decision | Rationale |
|---|---|---|
| A9 diff/merge CLI verbs | **ADDED** | In blast radius (cli.js + queue), <5 files, closes the loop both voices flagged as dead-ended |
| B0 cost-measurement baseline | **ADDED** | Reads existing telemetry, ~1 file; prevents net-negative B4 |
| A10 local demo script | **ADDED** | Mirrors existing demo scripts; proves time-to-first-ticket |
| `run --local` one-command wrapper | **DEFERRED → TODOS** | Outside blast radius; A10 is the stepping stone |
| GitLab backend adapter | **DEFERRED → TODOS** | No demand signal; trigger documented in NOT-in-scope |
| UI dashboard offline polish | **DEFERRED → TODOS** | Uncommitted ui/ work is a separate effort |
| flex-worker FS port | **SKIPPED** | Rejected at premise gate (P-C) |

## Step 0E — Temporal Interrogation (decisions resolved now, not during implementation)
- HOUR 1: Ticket ID scheme for FS tickets — `fs-<epochseconds>-<4char>` (sortable, collision-safe via queue-create's mktemp+mv); matches existing fixture shape.
- HOUR 2-3: Rejection path — `done/` + `rejected: true` + comment; no new queue state (state-machine shape frozen per NOT-in-scope).
- HOUR 2-3: Where intake reads findings — `.pipeline/findings/*.md`; consumed files are deleted after ticket creation (dedupe guarantee), capped by maxOpenTickets.
- HOUR 4-5: `merge` verb conflict behavior — read-only `git merge-tree` preflight; on predicted conflict, print conflict files + leave ticket in `ready-for-human/`. *(Original `--no-commit --no-ff` dry-run idea superseded by eng decision #20 — it mutates the index/worktree and is not a dry run; A9 is authoritative.)*
- HOUR 4-5: B5 tier resolution order — CLI `--model` > ticket-level override (none today) > `config.models[tier]` > built-in default.
- HOUR 6+: FS-mode orchestrator cycle summary destination — emit via the existing run-event stream (`.pipeline/runs/` events), no new log file.

## Step 0F — Mode
SELECTIVE EXPANSION (autoplan override). Committed; expansions decided above.

## CEO DUAL VOICES — CONSENSUS TABLE
```
═══════════════════════════════════════════════════════════════
  Dimension                            Claude   Codex   Consensus
  ───────────────────────────────────── ──────── ─────── ─────────
  1. Premises valid?                    CHALLENGE CHALLENGE DISAGREE (settled at premise gate D3)
  2. Right problem to solve?            REFRAME  REFRAME  CONFIRMED → trial-path framing adopted
  3. Scope calibration correct?         GAP      GAP      CONFIRMED gap → A9/A10 added
  4. Alternatives sufficiently explored? GAP     GAP      CONFIRMED gap → 0C-bis + inversion trigger recorded
  5. Competitive/market risks covered?  GAP      GAP      CONFIRMED gap → thin-plumbing/policy-moat note adopted
  6. 6-month trajectory sound?          CONCERN  CONCERN  CONFIRMED concerns → A5 merge-verify, B5 tiers, B2 fail-open
═══════════════════════════════════════════════════════════════
Consensus: 5/6 confirmed-and-addressed, 1 disagreement settled by user gate.
```
Codex-only positions overridden by confirmed premises (recorded, not adopted): single-process runner instead of queue (vs P-B), keep remote agents locally (vs P-C). Claude-only position adopted: B4 globalization risk → B0 precondition.

## Review Sections (CEO lens)

### Section 1 — Architecture
Local-loop dependency graph (new components marked *):
```
 .pipeline/findings/*.md ──▶ ticket-creator* ──▶ needs-review/ ──▶ ticket-reviewer* ──▶ needs-work/
                                          (creator output → needs-review/, per eng correction — NOT needs-triage/)
        ▲                         │ queue-create.sh*                                        │
   detectors (6, round-robin;     └── cap/severity gate*                                    ▼
   security conditional*)                                                            worker (exists)
                                                                                          │
 done/ ◀── agent-pipeline merge* ◀── ready-for-human/ ◀── code-reviewer ◀── tester ◀──────┘
   │              (cli.js)                                  (exist, v0.3.0)
   ▼
 cleanup* (merge-verified deletion)        branch-updater* (local merge-tree)
 orchestrator: snapshot via `agent-pipeline status` (exists) — dispatch table gains intake rows*
```
Findings (auto-decided): (1) A6 adds a second filtering axis (`backends`) orthogonal to `requires[]` — keep filter = requires ∧ backends, no new mechanism (P5). (2) `queue-create.sh` must use the family's mktemp-then-mv atomicity so two concurrent creators can't collide (P-B). Both folded into scope text. Coupling: A9 couples cli.js to git merge semantics — justified, it replaces hand-editing JSON. 10x load: 200 tickets in a state dir is still a cheap `ls`; no concern at local scale. Single point of failure: the orchestrator loop (already true today; unchanged).

### Section 2 — Error & Rescue Map (new codepaths)
See Error & Rescue Registry below — 15 rescue rows + 9 failure-mode rows mapped (eng later adds 13 more failure-mode rows; 22 failure rows total), 0 unrescued gaps remaining in plan text (cleanup unmerged-branch and B2 marker-corruption were gaps; both now specified fail-safe).

### Section 3 — Security & Threat Model
Local-only mode *shrinks* attack surface (no gh token, no Linear key required). New surfaces: (1) `queue-create.sh` builds JSON from detector-finding text — must use `jq -n --arg` (never string interpolation) to keep markdown/quotes from corrupting tickets; likelihood Med, impact Med, mitigated in A2 spec. (2) `agent-pipeline merge` runs git merge on user request — no arbitrary command execution; ticket fields (`branch`, `base`) must be passed as fixed-position git args, never shell-interpolated; mitigated. (3) Findings files are agent-written, human-readable — but security-detector's finding template embeds code snippets and its job is finding hardcoded secrets, so secret values CAN transit findings → tickets → comments; mitigated by A1's redaction contract (mask matched values, location + fingerprint only). *(Original "no secrets expected" claim corrected by adversarial review.)* No High-severity findings.

### Section 4 — Data Flow & Interaction Edge Cases
Findings→ticket flow shadow paths: nil/no findings → no-op (orchestrator skips dispatch); empty finding file → ticket-creator logs + deletes, no ticket; malformed finding (no title) → first line as title, fallback `untitled-<id>`; 50 findings burst → cap gate holds excess in findings/. Merge verb edges: dirty working tree → refuse with message; branch deleted → comment + leave ticket; double-merge (already merged) → detect via merge-base, move to done/ idempotently. Reviewer race (two reviewers claim same triage ticket) → existing mv-atomicity wins/ENOENT pattern covers it. All folded into scope/test expectations.

### Section 5 — Code Quality (CEO lens)
DRY: the "unresolved human comment" definition is restated in code-reviewer.md, feedback-responder.md, and orchestrator.md FS sections — B1's protocol consolidation should own that definition once and have agents reference it (folded into B1). Naming: `queue-create.sh` consistent with the verb-family; `modelTier` over `model` avoids name-drift (adopted in B5). No over-engineering detected post-refinement; the cap/severity gate is config-with-defaults, not new abstraction.

### Section 6 — Test Review (CEO lens; full test plan is the Eng phase artifact)
Every new codepath maps to a smoke or live tier in A8: queue-create (unit-ish smoke), init/start preflight (smoke), intake transitions (smoke + live), cleanup refusal (smoke — the 2am-Friday test), merge verb conflict/dirty/double (smoke), B2 fail-open (smoke), B5 tier resolution (smoke), full loop (live, $-budgeted). Chaos test: kill worker mid-ticket, assert queue-stale.sh recovery returns it to needs-work/ — already exists, extended to intake states.

### Section 7 — Performance
Queue scans are O(files) local reads — fine at local scale. The cap gate (A1) prevents detector-flood pathology. B6 cuts GitHub-mode API calls ~3x per PR. Model-tier routing (B5) is the dominant cost lever after B2's conditional scans. No further findings.

### Section 8 — Observability
Ticket `comments[]` is the audit trail; every new transition (create, reject, merge, cleanup-refusal) appends a provenance comment — folded into scope text. FS-mode cycle summary rides the existing run-event stream (0E decision). Debuggability test: "why didn't my finding become a ticket?" answerable from a log line (cap/severity skip logging required in A1). One finding, auto-decided into A1 text.

### Section 9 — Deployment & Rollout
No migrations, no servers. Ships as v0.4.0 npm + plugin. Symlink installs pick up agent prompt changes immediately on `npm update` — behavior changes ship silently to every symlinked project, so CHANGELOG discipline and the manifest version bump are part of the change (A7). Old `.pipeline/config.json` files lack `models`/`maxOpenTickets` keys — all new config reads need defaults (specified). Rollback = `npm install claude-agent-pipeline@0.3.0` or git revert; no persistent state format changes (ticket JSON gains optional fields only — backward compatible). Risk: low.

### Section 10 — Long-Term Trajectory
Reversibility 4/5 (prompts + one shell script + CLI verbs; only the manifest schema addition has mild stickiness). Debt knowingly taken: dual-backend prose (trigger documented). Debt removed: protocol duplication, detector overlap, unconditional scans. Knowledge: README quickstart + demo script + queue README. 1-year question: a new engineer reading "backends per agent in manifest, queue scripts as the contract" — legible. Strategy note (both voices): the queue/runner plumbing is being commoditized by first-party agent platforms; the defensible layer is the review-loop policy, detector suite, and fail-safe rules — keep plumbing thin (A6 stays minimal), invest in policy (Epic B compounds regardless of substrate).

### Section 11 — Design & UX
SKIPPED — no UI scope (1 grep match, below threshold; dashboard explicitly out of scope).

## Error & Rescue Registry
```
CODEPATH                      | WHAT CAN GO WRONG                        | HANDLING (specified)               | USER SEES
------------------------------|------------------------------------------|------------------------------------|------------------
queue-create.sh               | ID collision (concurrent creators)       | mktemp+mv atomicity; loser regens ID| nothing (transparent)
queue-create.sh               | malformed finding text (quotes/markdown) | jq -n --arg construction            | clean ticket JSON
ticket-creator (FS)           | findings flood                           | maxOpenTickets cap; excess stays    | log line "capped"
ticket-creator (FS)           | empty/garbage finding file               | delete + log, no ticket             | log line
ticket-reviewer (FS)          | reject path                              | done/ + rejected:true + comment     | comment explains why
pipeline-init (FS)            | gh absent                                | label step skipped by design        | quickstart printed
pipeline-start (FS)           | queue dirs missing                       | mkdir -p preflight                  | auto-fixed
agent-pipeline merge          | merge conflict                           | abort, list conflicts, ticket stays | conflict file list
agent-pipeline merge          | dirty working tree                       | refuse before attempting            | "commit/stash first"
agent-pipeline merge          | branch already merged / deleted          | idempotent done-move / comment+skip | status message
cleanup (FS)                  | done/ ticket, branch NOT merged          | refuse deletion + warning comment   | warning on ticket
branch-updater (FS)           | merge-tree conflict                      | comment with conflict summary       | comment
security-detector marker (B2) | marker missing/corrupt/pruned            | FAIL-OPEN: scan anyway              | nothing (safe)
dispatch model tier (B5)      | config.models missing                    | built-in default tier mapping       | nothing
orchestrator FS snapshot      | status --json fails / queue unreadable   | treat as empty + log, no dispatch   | event-stream entry
```

## Failure Modes Registry
```
CODEPATH                | FAILURE MODE                  | RESCUED? | TEST?        | USER SEES?          | LOGGED?
------------------------|-------------------------------|----------|--------------|----------------------|--------
queue-create.sh         | concurrent ID collision       | Y        | smoke (A8)   | nothing              | Y
ticket-creator FS       | findings flood                | Y (cap)  | smoke        | log line             | Y
ticket-reviewer FS      | double-claim race             | Y (mv)   | existing e2e | ENOENT loser exits   | Y
merge verb              | conflict mid-merge            | Y (abort)| smoke        | conflict list        | Y
merge verb              | dirty tree                    | Y        | smoke        | refuse message       | Y
cleanup FS              | unmerged branch in done/      | Y        | smoke        | warning comment      | Y
security marker (B2)    | marker corrupt                | Y (open) | smoke        | nothing (scans)      | Y
B4 extraction           | rules globalize token cost    | Y (B0)   | token check  | n/a                  | Y (measured)
init FS                 | rerun on existing .pipeline   | Y (idempotent mkdir/config merge) | smoke | confirmation | Y
```
No row is RESCUED=N ∧ TEST=N ∧ silent → **0 CRITICAL GAPS**.

## Dream State Delta
After this plan: the full loop runs locally end-to-end with a human merge surface; install/init are backend-honest; prompts are deduplicated and measured; dispatch is cost-tiered. Remaining distance to 12-month ideal: adapter inversion (triggered, not scheduled), one-command `run --local`, dashboard parity — all recorded in TODOS/NOT-in-scope.

## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|----------------|-----------|-----------|----------|
| 1 | CEO | Premises P-A..P-E confirmed | GATE (user) | — | user-approved at D3 | adjust P-C / P-A |
| 2 | CEO | Approach A (in-place port) over B (adapter inversion) | TASTE → final gate | P3,P5 | extends shipped v0.3.0 pattern; B's trigger documented | B now, C minimal |
| 3 | CEO | Adopt trial-path framing + time-to-first-ticket metric | Mechanical | P1 | both voices converged; no scope change | keep persona framing |
| 4 | CEO | Add A9 diff/merge CLI verbs | Taste (expansion, auto-approved) | P2 | in blast radius, <5 files; loop dead-ended without it | hand-edit JSON; dashboard |
| 5 | CEO | Add B0 measure-first | Mechanical | P6,P1 | telemetry exists; prevents net-negative B4 | ship B4 unmeasured |
| 6 | CEO | Add A10 demo script | Taste (expansion, auto-approved) | P2 | mirrors existing demos, proves TTFT | docs only |
| 7 | CEO | A5: merge-verify before deletion | Mechanical | P1 | done/ ≠ merged (Codex #7); destructive op needs proof | trust done/ |
| 8 | CEO | B2: fail-open on marker corruption | Mechanical | P-D,P1 | security scan must never silently stop | fail-closed |
| 9 | CEO | B5: capability tiers + destructive-agents-stay-default | Mechanical | P5,P-D | model names age; cheap models on destructive ops fail expensively | hardcoded haiku on cleanup |
| 10 | CEO | A1: maxOpenTickets cap + minSeverity gate | Mechanical | P1 | detector noise must not flood the queue (Codex #4) | unbounded intake |
| 11 | CEO | A8 split smoke/live tiers explicitly | Mechanical | P1 | "no spend where possible" was untestable as written | leave ambiguous |
| 12 | CEO | Reject single-process-runner reframe | Settled by gate | P-B | contradicts user-confirmed premise | adopt Codex reframe |
| 13 | CEO | Defer run --local, GitLab, dashboard to TODOS | Mechanical | P2,P3 | outside blast radius | expand now |

## CEO Completion Summary
```
+====================================================================+
|            MEGA PLAN REVIEW — COMPLETION SUMMARY (CEO)             |
+====================================================================+
| Mode selected        | SELECTIVE EXPANSION (autoplan override)     |
| System Audit         | clean stash; v0.3.0 fs-loop trajectory;     |
|                      | protocol dup confirmed byte-identical       |
| Step 0               | premises confirmed at gate (D3);            |
|                      | Approach A chosen (A-vs-B = taste decision) |
| Section 1  (Arch)    | 2 issues found (both folded into scope)     |
| Section 2  (Errors)  | 15 rescue + 9 failure rows, 0 GAPS left     |
| Section 3  (Security)| 3 issues found, 0 High severity             |
| Section 4  (Data/UX) | 11 edge cases mapped, 0 unhandled           |
| Section 5  (Quality) | 2 issues found (DRY comment-def; naming)    |
| Section 6  (Tests)   | Diagram produced, 0 unmapped codepaths      |
| Section 7  (Perf)    | 1 issue found (flood cap — addressed)       |
| Section 8  (Observ)  | 1 gap found (skip-logging — addressed)      |
| Section 9  (Deploy)  | 2 risks flagged (symlink propagation,       |
|                      | config defaults — both addressed)           |
| Section 10 (Future)  | Reversibility: 4/5, debt items: 1 (capped)  |
| Section 11 (Design)  | SKIPPED (no UI scope)                       |
+--------------------------------------------------------------------+
| NOT in scope         | written (7 items)                           |
| What already exists  | written (9 leverage rows)                   |
| Dream state delta    | written                                     |
| Error/rescue registry| 15 codepaths, 0 CRITICAL GAPS               |
| Failure modes        | 9 rows, 0 CRITICAL GAPS                     |
| TODOS.md updates     | 3 items deferred (run --local, GitLab, UI)  |
| Scope proposals      | 7 surfaced, 3 accepted, 3 deferred, 1 skip  |
| Outside voices       | ran (codex + claude subagent)               |
| Consensus            | 5/6 confirmed, 1 settled at premise gate    |
| Lake Score           | 11/11 recommendations chose complete option |
| Diagrams produced    | 2 (architecture, dream-state)               |
| Unresolved decisions | 1 taste (Approach A vs B) → final gate      |
+====================================================================+
```

---

# Eng Review (autoplan Phase 3 — FULL REVIEW)

## Step 0 — Scope Challenge
Existing-code leverage re-verified against source (manifest.json, bin/cli.js, api/index.js, queue/*.sh, orchestrator.md, security-detector.md, config.schema.json). Complexity check: ~25 files touched across prompts, queue scripts, CLI, API, schema, tests — above the 8-file threshold, but scope reduction is overridden by the autoplan directive (P2: never reduce); instead the review verified each item maps to a distinct verified breakage. **Scope accepted; five spec-level corrections and one scope addition (A11) folded in** — the review found the plan's *mechanisms* wrong in places, never its scope wrong. Prior learnings: none (project-scoped, 0 entries).

## ENG DUAL VOICES
Claude subagent (independent, no prior-phase context): **15 findings (3 P1, 6 P2, 6 P3)**. Codex (with CEO consensus context, adversarial): **10 findings (6 High, 4 Medium)**; verdict "would not approve as-is — direction sound, four architectural blockers." Every load-bearing claim was re-verified directly against source before adoption (manifest `requires` values, queue/README state definitions, orchestrator dispatch table + Task-tool mechanism, cli.js `ticket` verb, queue-claim lock absence, api/index.js queueDir hardcode, config.schema required array, security-detector fingerprint protocol). All verified true.

```
ENG DUAL VOICES — CONSENSUS TABLE:
═══════════════════════════════════════════════════════════════
  Dimension                           Claude  Codex   Consensus
  ──────────────────────────────────── ─────── ─────── ─────────
  1. Architecture sound?               ISSUES  ISSUES  CONFIRMED issues → A6 waiver rule, A1 rewiring, B5 dual-layer (all folded)
  2. Test coverage sufficient?         GAPS    GAPS    CONFIRMED gaps → B2 skip-path, version-skew, interleave, re-init tests (A8)
  3. Performance risks addressed?      GAP     GAP     CONFIRMED → B7 done/-scan scoping; cap counts non-terminal states
  4. Security threats covered?         GAP     —       Flagged regardless (single-voice rule) → ref validation + `--` separators (A9)
  5. Error paths handled?              ISSUES  ISSUES  CONFIRMED → merge-into-HEAD refusal, merge-tree preflight, squash fallback,
                                                        once-only warning, branch-updater conflict routing (A5/A9)
  6. Deployment risk manageable?       GAP     GAP     CONFIRMED → A11 config-schema scope item + version-skew smoke test
═══════════════════════════════════════════════════════════════
6/6 dimensions: both voices converged on real issues; zero cross-model DISAGREEs →
no new taste decisions; no finding contradicts the user's stated direction → no user challenges.
```

## Section 1 — Architecture
Dependency graph after eng corrections (new components `*`, corrected wiring `!`):
```
.pipeline/findings/*.md ─(frontmatter: severity/source/file/line)!─▶ ticket-creator*
     ▲    ▲                                                              │
detectors │                                                   queue-create.sh* (cap under lock)!
(security │ conditional via .security-scan.json marker*)                 │
          │                                                              ▼
.pipeline/findings/filed/ ◀──(fingerprint maintained by creator)!── needs-review/ !   [NOT needs-triage/]
                                                                         │
                                                              ticket-reviewer* ──reject──▶ done/ (+rejected:true)
                                                                         │approve
                                                                         ▼
                              needs-work/ ─▶ worker ─▶ … ─▶ ready-for-human/ ◀─(conflict→needs-feedback)!─ branch-updater*
                                                                         │
                                       agent-pipeline merge* (HEAD==base guard! · merge-tree preflight! · ref-validate!)
                                                                         │
                                done/ ─▶ cleanup* (ancestor ∨ patch-id fallback!; once-only warning!)
manifest.backends[linear|filesystem]! ─▶ cli.js install (github-dep waiver in FS installs)!
manifest.modelTier ─▶ dispatch.js (CLI path) AND orchestrator Task-tool dispatch rule! ◀─ config.models
api/index.js queueDir ◀─(resolved from config, was hardcoded)! ─ status --json ◀─ orchestrator FS snapshot
```
Findings (all confidence 9/10, verified by direct code reads; all folded into scope above):
- `[P1]` (9/10) manifest.json / bin/cli.js:166 — `filter = requires ∧ backends` keeps gh-less installs broken; seven FS-loop agents carry `requires:["github"]`. → A6 waiver rule. *(both voices)*
- `[P1]` (9/10) queue/README.md:11 / orchestrator.md:66 — A1's original wiring self-loops ticket-creator and kills `needs-review/`. → A1 rewired creator→`needs-review/`. *(both voices)*
- `[P1]` (9/10) git semantics — `merge <id>` merged into HEAD, not `ticket.base`; absent from the rescue registry despite its "0 unhandled" claim. → refuse-unless-on-base guard. *(Claude; Codex flagged the sibling dry-run-mutation issue)*
- `[P2]` (9/10) orchestrator.md:56 — production dispatch is Task-tool, bypassing dispatch.js; B5 as written missed the dominant path. → dual-layer resolution + B0(3). *(both voices)*
- `[P2]` (9/10) api/index.js:39 vs bin/cli.js:365 — queueDir split-brain for custom queue dirs. → A9 API fix. *(Codex)*
- `[P2]` (9/10) security-detector.md "Dedup via Fingerprint" — plan's ticket-dedupe ignored the shipped `findings/filed/` fingerprint system; two unsynchronized dedupe systems, rejection ping-pong. → A1 single-system dedupe. *(both voices)*
- `[P2]` (8/10) config.schema.json:6 — `required:["repo","ghUser"]` fails A3's gh-less init; new keys unscoped. → A11. *(Claude; Codex adjacent via backend-enum)*
- Naming: `backends:["github",…]` conflated dep with backend (config enum is `linear|filesystem`). → values renamed. *(Codex)*

## Section 2 — Code Quality
- `[P2]` (9/10) bin/cli.js:448 — `ticket new` would be swallowed by `runTicket` as an id lookup. → explicit subcommand branch (A2). *(Codex)*
- `[P2]` (8/10) A1 — `minSeverity` gate had no structured severity to read; prose-parsing per detector is fragile. → findings frontmatter contract (A1). *(Claude)*
- `[P3]` (9/10) queue-claim.sh:48 — no lock while queue-update.sh locks `.lock`; interleave can duplicate a ticket across two state dirs. → lock parity (A2). *(Claude)*
- DRY positive: dedupe-by-fingerprint reuses the detectors' existing protocol instead of inventing a parallel ticket-side scheme — one system, one key.
- No over-engineering found post-correction; the refuse-unless-on-base merge guard was chosen over a temp-worktree merge precisely to avoid hidden machinery (explicit > clever, P5).

## Section 3 — Test Review
Framework: repo's bespoke harness — `npm test` (CLI smoke, no model spend), `npm run test:e2e:smoke` (test/e2e/, seeded fixture), `CAP_E2E_LIVE=1` live tier (README Development section). Plan-stage coverage map (plan code, not diff):
```
CODE PATHS (planned)                                      COVERAGE (tier)
[+] queue/queue-create.sh
  ├── atomic create (mktemp+mv)                           [PLANNED smoke]
  ├── cap at boundary, 2 concurrent creators              [PLANNED smoke]  ← added by eng
  ├── malformed finding text (jq -n --arg)                [PLANNED smoke]
  └── id collision regen                                  [PLANNED smoke]
[+] queue/queue-claim.sh lock parity (claim/update race)  [PLANNED smoke]  ← added by eng
[+] ticket-creator FS
  ├── output lands in needs-review/                       [PLANNED smoke+live] ← rewired by eng
  ├── fingerprint dedupe / rejected not re-ticketed       [PLANNED smoke]  ← added by eng
  ├── severity-frontmatter gate + skip log line           [PLANNED smoke]
  └── empty/garbage finding → delete+log                  [PLANNED smoke]
[+] ticket-reviewer FS approve / reject(+rejected:true)   [PLANNED smoke+live]
[+] pipeline-init FS / re-run backend switch              [PLANNED smoke]  ← re-run added by eng
[+] pipeline-start FS preflight                           [PLANNED smoke]
[+] cli diff <id>                                         [PLANNED smoke]
[+] cli merge <id>
  ├── clean merge → done/ + provenance comment            [PLANNED smoke]
  ├── conflict (merge-tree preflight) → abort+list        [PLANNED smoke]
  ├── dirty tree refusal                                  [PLANNED smoke]
  ├── wrong checked-out branch refusal                    [PLANNED smoke]  ← added by eng
  ├── ref option-injection rejection                      [PLANNED smoke]  ← added by eng
  └── double-merge idempotency                            [PLANNED smoke]
[+] cli ticket new (parser collision with ticket <id>)    [PLANNED smoke]  ← added by eng
[+] cleanup FS: refusal / squash patch-id / once-only     [PLANNED smoke]  ← 2 of 3 added by eng
[+] branch-updater FS conflict → needs-feedback           [PLANNED live]   [→E2E] prompt behavior
[+] B2 marker: fail-open AND skip-when-unchanged          [PLANNED smoke]  ← skip path added by eng
[+] B5 tier resolution: dispatch.js path                  [PLANNED smoke]
[+] B5 orchestrator Task-tool path                        [PLANNED live]   [→E2E] prompt behavior
[+] B7 done/ scan exclusion                               [live only]      [→E2E] prompt behavior
[+] A11 minimal FS config validates                       [PLANNED smoke]  ← added by eng
[+] v0.3 config + v0.4 prompts (version skew)             [PLANNED smoke]  ← added by eng
[+] B1/B4 token deltas (changed shrink, worker stable)    [measurement]
USER FLOWS
[+] TTFT <10min quickstart                                [demo script A10, mechanical]
[+] "why didn't my finding become a ticket?"              [smoke: log-line assertion]
[+] full local loop, gh shimmed                           [live, $-budgeted]
COVERAGE: 28/28 planned paths mapped (100%) | smoke: 24 | live-only: 3 (agent-prompt behavior) | measurement: 1
```
Known limitation (logged, not a gap): agent-*prompt* behavior (orchestrator dispatch decisions, B7 scan scoping) is only assertable in the live tier or by manual transcript inspection — inherent to prompt-as-code; the smoke tier covers every mechanical surface. No regressions identified (all changes are new paths or guarded extensions of existing ones); REGRESSION RULE not triggered. Test plan artifact written: `ryan-main-test-plan-20260609-235438.md` (reviewer's local gstack artifact store, not in this repo). No LLM eval suites configured in this repo; prompt changes are covered by the live tier + token-delta checks (B0/B4).

## Section 4 — Performance
- `[P2]` (9/10) orchestrator.md:277 + A1/A9 — every-cycle `comments[]` scan over an unbounded `done/` archive; an LLM re-reading a growing terminal state each cycle fights Epic B directly. → B7 (state-based exclusion; P-D preserved). *(Claude; Codex's cap-scope finding is the same pathology from the intake side)*
- `[P2]` (8/10) A1 — `maxOpenTickets` originally counted only 2 of 8 open states; intake could flood a saturated downstream. → cap counts all non-terminal states. *(Codex)*
- B6 unchanged (GraphQL batching, ~3x fewer calls/PR/cycle). B0's telemetry-source correction (events.jsonl, not run.json) protects the measurement itself. Queue scans remain O(files) local reads — fine at local scale with the cap in place.

## Worktree Parallelization Strategy
| Step | Modules touched | Depends on |
|---|---|---|
| B0 measure | .pipeline/runs (read-only), scripts/ | — |
| A2 queue-create + lock parity | queue/ | — |
| A3/A4 init+start | commands/ | — |
| A6+A11 backend filter + schema | manifest.json, bin/cli.js, config.schema.json | — |
| A9 CLI verbs + API queueDir | bin/cli.js, api/ | A2 (reads tickets) |
| A12 doctor verb | bin/cli.js, docs/API.md | A6+A11 (validates config/schema/agent-set) |
| A1 intake + B7 scan scope | agents/, queue/README | A2 |
| A5 lifecycle FS paths | agents/ | A1 (state semantics) |
| B1–B5 efficiency | agents/, rules/, manifest.json, runner/ | B0 |
| A8 e2e | test/ | all above |
| A7/A10 docs+demo | README, scripts/ | A8 green |

Lanes: **A:** A2 → A1 → A5 (sequential, shared queue/+agents/). **B:** A3/A4 (independent, commands/). **C:** A6+A11 → A9 → A12 (sequential, shared bin/cli.js — A12 was missing from this table; added by adversarial review). **D:** B0 → B1–B5 (sequential; B-epic touches agents/ — merge AFTER lane A to avoid prompt-file conflicts). Launch A+B+C+D(B0 only) in parallel worktrees; merge A,B,C; run B1–B5; A8 accumulates per-lane; A7/A10 last. Conflict flags: lanes A and D both touch `agents/` (sequence them); lanes C's A9/A12 both touch `bin/cli.js` (same lane).

## Failure Modes Registry — eng additions
```
CODEPATH                | FAILURE MODE                        | RESCUED?            | TEST?  | USER SEES?        | LOGGED?
------------------------|-------------------------------------|---------------------|--------|-------------------|--------
merge verb              | wrong checked-out branch (≠ base)   | Y (refuse)          | smoke  | "checkout <base>" | Y
merge verb              | ref starts with '-' (option inject) | Y (check-ref-format + --) | smoke | error msg    | Y
merge verb              | --no-commit preflight mutates tree  | Y (merge-tree instead) | smoke | nothing        | Y
cleanup FS              | squash-merge defeats ancestor check | Y (patch-id fallback)| smoke | nothing           | Y
cleanup FS              | warning comment spam per cycle      | Y (once-only)       | smoke  | single comment    | Y
ticket-creator FS       | rejected finding re-filed forever   | Y (fingerprint+filed/) | smoke | log line       | Y
ticket-creator FS       | cap race (2 creators at N-1)        | Y (lock in queue-create) | smoke | log line      | Y
branch-updater FS       | conflicted ticket left mergeable    | Y (route→needs-feedback) | live | state+comment | Y
queue claim/update race | ticket duplicated across 2 states   | Y (lock parity)     | smoke  | nothing           | Y
orchestrator FS         | unbounded done/ comment scan        | Y (B7 exclusion)    | live   | n/a               | n/a
api status/ticket       | custom queueDir split-brain         | Y (A9 config fix)   | smoke  | correct status    | Y
B2 marker               | always-scan regression (skip dead)  | Y (skip-path test)  | smoke  | n/a               | Y
B5 Task-tool path       | tier silently ignored in production | Y (dual-layer rule) | live   | n/a               | Y
```
No row is RESCUED=N ∧ TEST=N ∧ silent → **0 CRITICAL GAPS** (registry now 22 rows total across both reviews).

## Implementation Tasks (eng)
Synthesized from this review's findings; aggregated with the DX task list (D1–D9) at the final gate. (The CEO phase produced no separate task list — its additions are already folded into scope items A9/A10/B0.)

- [ ] **E1 (P1, human: ~4h / CC: ~30min)** — installer — implement A6 backend-scoped dep waiver + rename backends values to linear|filesystem
  - Surfaced by: Section 1 — filter conjunction keeps gh-less installs broken (both voices)
  - Files: manifest.json, bin/cli.js, test/
  - Verify: `install --backend filesystem --dry-run` on gh-less PATH lists worker+orchestrator
- [ ] **E2 (P1, human: ~3h / CC: ~20min)** — intake — rewire A1 creator output to needs-review/; reconcile state table across orchestrator.md/queue README/init
  - Surfaced by: Section 1 — self-loop + dead state (both voices)
  - Files: agents/ticket-creator.md, agents/ticket-reviewer.md, agents/orchestrator.md, queue/README.md, commands/pipeline-init.md
  - Verify: smoke — creator output dir; no needs-triage self-dispatch
- [ ] **E3 (P1, human: ~4h / CC: ~30min)** — merge verb — HEAD==base guard, merge-tree preflight, ref validation, `--` separators
  - Surfaced by: Section 1/2 — merge-into-HEAD + injection + fake dry-run (both voices)
  - Files: bin/cli.js, api/index.js, test/
  - Verify: smoke — wrong-branch refusal, `-`-prefixed ref rejection, no tree mutation on conflict
- [ ] **E4 (P2, human: ~2h / CC: ~15min)** — dedupe — fingerprint-keyed dedupe integrated with .pipeline/findings/filed/
  - Surfaced by: Section 1 — two unsynchronized dedupe systems, rejection ping-pong (both voices)
  - Files: agents/ticket-creator.md, queue/queue-create.sh
  - Verify: smoke — rejected finding not re-ticketed
- [ ] **E5 (P2, human: ~2h / CC: ~15min)** — config — A11 schema work (conditional required, new keys, defaults)
  - Surfaced by: Section 1 — schema changes implied but unscoped
  - Files: config.schema.json, commands/pipeline-start.md, test/
  - Verify: minimal FS config validates; v0.3 config + v0.4 prompts smoke
- [ ] **E6 (P2, human: ~2h / CC: ~15min)** — B5 — dual-layer tier resolution (dispatch.js + orchestrator Task-tool rule)
  - Surfaced by: Section 1 — production dispatch bypasses dispatch.js (both voices)
  - Files: manifest.json, runner/dispatch.js, agents/orchestrator.md
  - Verify: smoke — dispatch.js resolution; live — orchestrator passes model
- [ ] **E7 (P2, human: ~1h / CC: ~10min)** — queue — cap counts non-terminal states, enforced in queue-create.sh under lock
  - Surfaced by: Section 4 — wrong backlog + read-then-create race
  - Files: queue/queue-create.sh, agents/ticket-creator.md
  - Verify: smoke — cap-at-boundary with 2 concurrent creators
- [ ] **E8 (P2, human: ~1h / CC: ~10min)** — orchestrator — B7 done/-exclusion for FS comment scan
  - Surfaced by: Section 4 — unbounded terminal-archive scan
  - Files: agents/orchestrator.md
  - Verify: live tier / transcript inspection
- [ ] **E9 (P2, human: ~2h / CC: ~15min)** — lifecycle — squash patch-id fallback + once-only warning (cleanup); conflict→needs-feedback routing (branch-updater)
  - Surfaced by: Section 1/2 — error-path gaps (both voices)
  - Files: agents/cleanup.md, agents/branch-updater.md
  - Verify: smoke — squash fallback, single warning; live — routing
- [ ] **E10 (P2, human: ~1h / CC: ~10min)** — B2 — marker spec (.security-scan.json) + skip-path smoke test
  - Surfaced by: Section 3 — only fail-open was tested; marker location unspecified
  - Files: agents/orchestrator.md, agents/security-detector.md, test/
  - Verify: smoke — skip-when-unchanged AND fail-open
- [ ] **E11 (P3, human: ~1h / CC: ~10min)** — queue — queue-claim.sh lock parity with queue-update.sh
  - Surfaced by: Section 2 — claim/update interleave duplicates tickets
  - Files: queue/queue-claim.sh, test/
  - Verify: smoke — interleave test
- [ ] **E12 (P3, human: ~1h / CC: ~10min)** — CLI — `ticket new` subcommand branch before id lookup
  - Surfaced by: Section 2 — verb collision with `ticket <id>`
  - Files: bin/cli.js, test/
  - Verify: smoke — both verbs work
- [ ] **E13 (P3, human: ~2h / CC: ~15min)** — detectors — findings frontmatter contract (severity/source/file/line) across detector prompts
  - Surfaced by: Section 2 — minSeverity gate had nothing structured to read
  - Files: agents/*-detector.md, agents/ticket-creator.md
  - Verify: smoke — gate reads frontmatter fixture
- [ ] **E14 (P3, human: ~1h / CC: ~10min)** — B0 — events.jsonl token extraction + dispatch-path determination
  - Surfaced by: Section 1/4 — run.json lacks token counts; production path unknown
  - Files: scripts/ (measurement), docs
  - Verify: B0 report names the dominant dispatch path with numbers

## Decision Audit Trail (eng rows — continues CEO table)

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|----------------|-----------|-----------|----------|
| 14 | Eng | A1 creator output → `needs-review/` + state-table reconciliation | Mechanical | P1,P5 | both voices: original wiring self-loops creator, kills needs-review/ | new state; repurpose needs-review |
| 15 | Eng | Dedupe = detector fingerprint + maintain findings/filed/ | Mechanical | P4 | one dedupe system, not two unsynchronized ones; survives done/ pruning | ticket-title matching |
| 16 | Eng | Cap counts all non-terminal states, enforced in queue-create.sh under lock | Mechanical | P1 | prompt-level count is a race; 2-of-8-states cap misses saturation | prompt-enforced cap |
| 17 | Eng | Findings frontmatter contract (severity/source/file/line) | Mechanical | P5 | minSeverity gate needs structure, not prose parsing | per-detector prose parsing |
| 18 | Eng | A6: backends values = linear\|filesystem + github-dep waiver rule | Mechanical | P1,P5 | plain requires∧backends provably keeps gh-less installs broken | flat second axis; per-backend requires maps |
| 19 | Eng | merge verb: refuse unless HEAD == ticket.base | TASTE (auto, surfaced at gate) | P5,P3 | explicit refusal over hidden temp-worktree machinery; one-line user fix | temp-worktree merge (9/10 complete, more machinery) |
| 20 | Eng | merge preflight via git merge-tree, never --no-commit --no-ff | Mechanical | P1 | "--no-commit" mutates index/worktree — not a dry run | merge+abort cleanup path |
| 21 | Eng | Ref validation (check-ref-format) + `--` separators in new verbs | Mechanical | P1 | agent-written ticket fields reachable as git options | trust fixed-position args |
| 22 | Eng | api/index.js resolves config queueDir (A9 includes fix) | Mechanical | P1,P2 | status/ticket/verbs read through API; split-brain otherwise; 1-function fix | declare custom queueDir unsupported |
| 23 | Eng | cleanup: patch-id fallback + once-only warning | Mechanical | P1 | squash merges defeat ancestor check (cleanup.md:112 self-documents); no comment spam | warn every cycle |
| 24 | Eng | branch-updater FS conflict → needs-feedback routing | Mechanical | P1,P4 | mirrors shipped GitHub-mode routing; comment-only leaves conflicted ticket mergeable | comment-only |
| 25 | Eng | B0 gains dispatch-path determination + events.jsonl fallback | Mechanical | P6,P1 | run.json has no token counts; Task-tool path bypasses dispatch.js | assume runner telemetry suffices |
| 26 | Eng | B2 marker spec + skip-path test added | Mechanical | P1 | untested skip = silent erasure of the savings | fail-open test only |
| 27 | Eng | B5 dual-layer resolution (dispatch.js + orchestrator rule) | Mechanical | P1 | production dispatch is Task-tool (orchestrator.md:56) | dispatch.js only |
| 28 | Eng | B7: exclude done/ from FS comment scan (state-based, not timestamp) | Mechanical | P1,P-D | unbounded terminal-archive scan; P-D preserved for active tickets | scan everything forever |
| 29 | Eng | A11 config-schema scope item added | Mechanical (expansion <1 day) | P2 | schema validation would fail A3's output; keys were unscoped | leave implicit |
| 30 | Eng | A2: `ticket new` parser branch + queue-claim lock parity | Mechanical | P1,P5 | verb collision verified at cli.js:448; claim/update interleave race | separate top-level verb; ignore race |
| 31 | Eng | A8 gains version-skew + re-init + interleave + skip-path tests | Mechanical | P1 | each maps to a verified failure mode | ship without |

## ENG Completion Summary
```
+====================================================================+
|              PLAN ENG REVIEW — COMPLETION SUMMARY                   |
+====================================================================+
| Step 0: Scope Challenge | scope accepted as-is (autoplan P2);      |
|                         | 5 spec corrections + 1 addition (A11)    |
| Architecture Review     | 8 issues found (3 P1) — all folded       |
| Code Quality Review     | 5 issues found — all folded              |
| Test Review             | diagram produced, 9 gaps identified,     |
|                         | all added to A8; artifact written        |
| Performance Review      | 2 issues found — B7 added, cap rescoped  |
| NOT in scope            | unchanged (7 items, re-validated)        |
| What already exists     | re-verified vs source; fingerprint       |
|                         | system added as 10th leverage row        |
| TODOS.md updates        | 3 CEO items (+2 DX later; file totals 5) |
| Failure modes           | 13 eng rows added, 0 critical gaps       |
| Outside voice           | ran (codex + claude subagent, dual)      |
| Parallelization         | 4 lanes, 3 parallel + 1 gated on B0      |
| Lake Score              | 18/18 recommendations chose complete     |
| Unresolved decisions    | 0 new; 2 taste total → final gate        |
|                         | (Approach A-vs-B; merge guard vs         |
|                         | temp-worktree)                           |
+====================================================================+
```

---

# DX Review (autoplan Phase 3.5 — DX POLISH)

Product type: **CLI tool + Claude Code plugin** (primary: CLI). Mode: DX POLISH (enhancement to an existing product — autoplan override). No prior DX reviews on this project (trend: first baseline).

## Developer Persona (Step 0A — inferred per autoplan P6)
```
TARGET DEVELOPER PERSONA
========================
Who:       Solo developer / small-team lead already using Claude Code, trialing
           autonomous pipelines on a side project or internal repo
Context:   Found the repo via npm/GitHub; has an Anthropic subscription and git;
           does NOT have Linear and may not have gh auth on this machine
Tolerance: ~10 minutes / 3-4 commands before abandoning; copies from README,
           won't read docs/API.md until something works
Expects:   npx install → one init command → something visibly happens
```

## Developer Empathy Narrative (Step 0B — grounded in current README/commands)
I open the README. The pitch sounds right — "self-orchestrating multi-agent pipeline." I run `npx claude-agent-pipeline install .` and it works; nice. Then "First-run setup" (which I only find at line 149, *below* the full CLI and API reference) tells me to run `/pipeline init` in Claude Code. The wizard asks me to confirm a repo slug from `gh` — which I don't have on this machine — then my GitHub user, a backend, verify commands, a worktree root, rules seeding, a lessons directory, gitignore changes. Eleven steps in, I notice the Backends section calls filesystem an "offline fallback" and the minimum config example requires `repo` and `ghUser`. I picked this tool because I *don't* want to wire up GitHub for a trial. `/pipeline start` then fails on `gh auth status`. There's no example of a working local config, no "here's the one command that proves the loop works", and when I guess my way to a queue dir, nothing tells me why no tickets appear. I give up around minute twelve, which the plan's own framing says is two minutes too late.

## Competitive DX Benchmark (Step 0C)
```
COMPETITIVE DX BENCHMARK
=========================
Tool                  | TTHW        | Notable DX Choice                       | Source
aider                 | ~2-3 min    | pip install + API key + `aider` in repo | aider.chat/docs/install
OpenHands             | ~5-10 min   | `openhands serve` → localhost:3000 UI   | docs.openhands.dev
Copilot agent mode    | ~2 min      | lives inside the editor, zero new tools | landscape reviews (2026)
Reference: Stripe 30s, Vercel 2min, Docker 5min
claude-agent-pipeline | ~12+ min ✗  | install is 1 cmd; init/start gh-coupled | current README/commands
  (post-plan)         | <5 min ✓    | deterministic ticket-new hello world    | this plan (A3/A7 fast path)
```
Tier chosen (auto, P5/P1): **Competitive (2-5 min)** for the hello-world checkpoint; the full autonomous loop keeps the <10 min TTFT target. Champion tier would require hosted sandbox work — out of proportion for a CLI plugin trial.

## Magical Moment (Step 0D — lowest-effort vehicle achieving the tier, per autoplan P5)
The moment: **watching an agent claim your ticket and open a branch with real changes — on a repo with zero remote setup.** Vehicle: **copy-paste demo command block** (README quickstart + `scripts/demo-local-loop.sh`, both already in scope as A7/A10) — `npx create-next-app`-style, no hosted environment needed. The quickstart's `agent-pipeline ticket new "hello local pipeline"` makes the first act deterministic; the orchestrator picking it up is the magic.

## Developer Journey Map (Step 0F — post-review status)
```
STAGE           | DEVELOPER DOES                       | FRICTION POINTS                              | STATUS
----------------|--------------------------------------|----------------------------------------------|--------
1. Discover     | npm/GitHub README                    | "offline fallback" framing repels the persona | fixed (A7.2)
2. Install      | npx claude-agent-pipeline install .  | backend-blind agent set; silent gh waiver gap | fixed (A6)
3. Hello World  | /pipeline init → ticket new          | 11-step wizard; gh hard-required; no det. seed| fixed (A3 fast path, A4, A7.1)
4. Real Usage   | /pipeline start → loop runs          | skips invisible (no obs step in quickstart)   | fixed (A7.1 + msg contract)
5. Debug        | "why no ticket?"                     | log lines with no destination or config key   | fixed (contract + A12 doctor)
6. Upgrade      | npm update (symlink mode)            | silent behavior changes; no config versioning | fixed (A7.6/.7, A11)
```

## First-Time Developer Confusion Report (Step 0G)
```
Persona: solo Claude Code dev, no gh on machine
T+0:00  npx install — works. README CLI table doesn't mention status/ticket/diff/merge. (fixed: A7.3)
T+1:00  /pipeline init — asked for GitHub user I don't have. (fixed: A3 detect + pre-select FS)
T+4:00  Wizard question #6 about worktree roots — "do I need to care?" (fixed: A3 fast path)
T+6:00  /pipeline start — gh auth failure. (fixed: A4)
T+8:00  Backend section says "offline fallback"; wonders if local mode is real. (fixed: A7.2)
T+10:00 No ticket appears; nothing says detectors run on a cycle cadence. (fixed: A7.1 seed-first + obs step)
T+12:00 Gives up. (post-plan: first ticket visible at ~T+4:00)
```

## DX DUAL VOICES
Claude subagent (independent): **13 findings (4 High, 7 Medium, 2 Low)** — TTFT unfalsifiable as written, docs scope missing CLI/API surface, no error-message contract, log lines with no watched destination, init wizard weight, verb-grammar inconsistency, backend-signal conflation, README contradiction, no reopen hatch, ticket-new surface unspecified, conflict dead-end, B2 hatch undocumented, tier naming. Codex (with prior-phase context): **5 dimensions, ~12 concerns** — verdict "directionally strong, DX one iteration short"; quickstart must be one copy-paste block with deterministic seed, error registry needs user-facing copy, `doctor` verb, README restructure + minimal FS config, config versioning + migration notes, `run --local` deferral challenged, `ticket merge` vs top-level `merge`. Init-wizard and README claims re-verified against commands/pipeline-init.md (11 steps) and README.md:149,186 before adoption.

```
DX DUAL VOICES — CONSENSUS TABLE:
═══════════════════════════════════════════════════════════════
  Dimension                           Claude  Codex   Consensus
  ──────────────────────────────────── ─────── ─────── ─────────
  1. Getting started < 5 min?          NO      NO      CONFIRMED gap → A3 fast path + A7.1 deterministic seed + <5min checkpoint
  2. API/CLI naming guessable?         ISSUES  MIXED   CONFIRMED → grammar rule + ticket-new signature (verb shape = taste, at gate)
  3. Error messages actionable?        NO      NO      CONFIRMED → error-message contract + A12 doctor
  4. Docs findable & complete?         GAPS    GAPS    CONFIRMED → A7 expanded 1→7 items (README restructure, API/help parity)
  5. Upgrade path safe?                —       GAPS    Flagged regardless (single-voice rule) → A11 configVersion + A7.6/.7
  6. Dev environment friction-free?    ISSUES  ISSUES  CONFIRMED → init fast path, backend echo, smoke tests CI-runnable
═══════════════════════════════════════════════════════════════
0 cross-model DISAGREEs on direction. Codex's run --local challenge contests a
CEO-phase deferral (not user-stated direction) → TASTE DECISION at gate, mitigated
by the deterministic quickstart either way.
```

## The 8 Passes (DX POLISH — scores are post-fix, evidence-cited)
1. **Getting Started: 3/10 → 8/10.** Was: quickstart buried at README:149, gh-required init, 11-step wizard, hello world dependent on detector nondeterminism (persona abandons at ~min 12 per 0G). Now: quickstart at top, FS pre-select, fast-path init, `ticket new` seed, <5 min checkpoint in Verification. A 10 would be a hosted sandbox — out of scope for a CLI plugin (deferred rationale in NOT-in-scope).
2. **API/CLI Design: 6/10 → 8/10.** Was: three grammars for one resource (`ticket <id>`, `ticket new`, top-level `diff`/`merge`), `--without github` as backend signal, unspecified `ticket new` surface. Now: signature specified, signal hygiene + precedence + backend echo, grammar rule explicit (nouns own create/show/reopen; git-semantic actions stay top-level verbs mirroring git's own mental model). Verb shape surfaced as taste at the gate.
3. **Error Messages: 5/10 → 9/10.** Was: registry specified *that* failures are rescued but copy was "log line"/"nothing". Now: contract (problem + cause + exact fix naming the config key/command) on every user-facing refusal across A1/A2/A9/A12, plus `doctor` for the stuck states. Stripe-tier structured errors (JSON + doc_url) would be a 10 — overkill for a local CLI, noted and skipped.
4. **Documentation: 4/10 → 8/10.** Was: A7 one line; README contradicts the plan's own framing; demonstrated doc-drift (CLI table already missing 4 shipped verbs). Now: A7 has 7 enumerated items with an every-verb-in---help acceptance check and a minimal FS config example.
5. **Upgrade Path: 6/10 → 8/10.** Was: CHANGELOG discipline noted (CEO §9) but nothing user-facing. Now: `configVersion` + deprecation note + migration entry + symlink-update warning in install output. Codemods would be a 10 — no breaking config change exists to codemod (new keys all default).
6. **Dev Environment: 7/10 → 8/10.** Already strong (no runtime deps, smoke tier needs no model spend, macOS flock fallback shipped in v0.3). Now: init fast path makes non-interactive-ish trial real; smoke tests are CI-runnable; gh shimming pattern documented by the e2e suite.
7. **Community & Ecosystem: 6/10 → 6/10.** MIT, open repo, demo scripts as runnable examples, custom-agent extension point documented in README. No community channel / CONTRIBUTING.md — real gap, not this plan's scope → TODOS. No regression; no change.
8. **DX Measurement: 5/10 → 7/10.** TTFT is now mechanically measurable (A10 demo script timing), B0 instruments cost per agent, A8 asserts the skip-log visibility. No journey analytics — appropriate for a local-first tool (nothing phones home); boomerang-ready: /devex-review can re-measure TTFT against the same script.

**Claude Code plugin checklist (appendix, non-scored):** bounded autonomy ✓ (cleanup merge-verify, B5 destructive-stays-standard), audit trail ✓ (comments[] provenance), error recovery ✓ (queue-stale + fail-open), state storage ✓ (per-project .pipeline/), session continuity ✓ (runs/ events), progressive consent ✓ (init asks before labels/gitignore). No unchecked items introduced by this plan.

## DX Scorecard
```
+====================================================================+
|              DX PLAN REVIEW — SCORECARD                             |
+====================================================================+
| Dimension            | Score  | Prior  | Trend  |
|----------------------|--------|--------|--------|
| Getting Started      |  8/10  |   —    | baseline |
| API/CLI/SDK          |  8/10  |   —    | baseline |
| Error Messages       |  9/10  |   —    | baseline |
| Documentation        |  8/10  |   —    | baseline |
| Upgrade Path         |  8/10  |   —    | baseline |
| Dev Environment      |  8/10  |   —    | baseline |
| Community            |  6/10  |   —    | baseline (→ TODOS)
| DX Measurement       |  7/10  |   —    | baseline |
+--------------------------------------------------------------------+
| TTHW                 | <5 min (hello-world) / <10 min (full loop); was ~12+ min broken |
| Competitive Rank     | Competitive (was Red Flag for the no-gh persona)                |
| Magical Moment       | designed — agent claims your seeded ticket; via copy-paste demo |
| Product Type         | CLI tool + Claude Code plugin                                   |
| Mode                 | POLISH                                                          |
| Overall DX           |  8/10 (pre-review plan: 5/10; pre-plan reality: 3/10)           |
+====================================================================+
| DX PRINCIPLE COVERAGE                                               |
| Zero Friction      | covered (A3 fast path, A6 waiver, A4)          |
| Learn by Doing     | covered (quickstart + demo script)             |
| Fight Uncertainty  | covered (msg contract, doctor, obs step)       |
| Opinionated + Escape Hatches | covered (defaults + reopen, force-scan, config overrides, --all) |
| Code in Context    | covered (quickstart shows expected output)     |
| Magical Moments    | covered (seeded-ticket-to-branch moment)       |
+====================================================================+
```
Community 6/10 flagged as the only sub-8 dimension — ecosystem debt, deferred with rationale (TODOS), does not block adoption for the target persona.

## DX Implementation Checklist
```
DX IMPLEMENTATION CHECKLIST
============================
[ ] Hello-world checkpoint < 5 min (install → init fast-path → ticket new, timed by A10)
[ ] Full-loop TTFT < 10 min (README-quickstart-only, demo script proves)
[ ] Installation is one command (npx claude-agent-pipeline install . --backend filesystem)
[ ] First run produces meaningful output (installer echoes resolved backend + agent set)
[ ] Magical moment delivered via copy-paste quickstart (seeded ticket → agent branch)
[ ] Every user-facing refusal/skip: problem + cause + exact fix + config key (A1/A2/A9/A12)
[ ] CLI grammar rule stated in A9; ticket new signature specified (A2)
[ ] Every verb appears in --help, docs/API.md, README CLI table (A7.3 acceptance)
[ ] README: local quickstart at top; "offline fallback" framing removed; minimal FS config example
[ ] Quickstart includes observability step (status/events) and expected output per command
[ ] configVersion written by init; deprecation note on v0.3-shape configs; CHANGELOG migration entry
[ ] Symlink-mode update warning in install output
[ ] doctor verb: state-aware triage with contract-compliant messages
[ ] ticket reopen <id> escape hatch; B2 force-scan hatch documented
[ ] Works in CI (smoke tier, no model spend, gh shimmed)
[ ] Free trial intact: no GitHub, no Linear, no credit card — Anthropic access only (stated in prereqs)
```

## Implementation Tasks (DX)
- [ ] **D1 (P1, human: ~4h / CC: ~30min)** — docs — A7 README restructure: quickstart at top w/ deterministic seed + expected output + obs step; rewrite Backends/Configuration; minimal FS config
  - Surfaced by: Passes 1/4 — both voices; README:149/186 verified
  - Files: README.md
  - Verify: TTFT walkthrough follows README only; no "offline fallback" string
- [ ] **D2 (P1, human: ~2h / CC: ~15min)** — cli — error-message contract across A1/A2/A9/A12 refusals/skips
  - Surfaced by: Pass 3 — both voices
  - Files: bin/cli.js, queue/*.sh, agents/ticket-creator.md
  - Verify: smoke asserts message names config key/command
- [ ] **D3 (P2, human: ~3h / CC: ~20min)** — cli — A12 doctor verb (state-aware triage)
  - Surfaced by: Pass 3 — Codex voice
  - Files: bin/cli.js, docs/API.md, test/
  - Verify: doctor on broken fixture prints fix-bearing findings
- [ ] **D4 (P2, human: ~2h / CC: ~15min)** — init — A3 accept-all-defaults fast path
  - Surfaced by: Pass 1/6 — both voices; pipeline-init.md 11 steps verified
  - Files: commands/pipeline-init.md
  - Verify: FS init = 1 confirmation in demo script
- [ ] **D5 (P2, human: ~1h / CC: ~10min)** — cli — ticket new signature + ticket reopen verb
  - Surfaced by: Pass 2 — both voices (reopen: Claude #9)
  - Files: bin/cli.js, queue/queue-create.sh, docs/API.md
  - Verify: bare `ticket new` prints usage; reopen moves done→needs-work with comment
- [ ] **D6 (P2, human: ~2h / CC: ~15min)** — docs/cli — verb-in---help parity (HELP string, docs/API.md, README table) + slash-command naming consistency
  - Surfaced by: Pass 4 — Claude #2; README drift verified
  - Files: bin/cli.js, docs/API.md, README.md, commands/
  - Verify: acceptance check — every verb in --help and both docs
- [ ] **D7 (P2, human: ~1h / CC: ~10min)** — config — configVersion + deprecation note + CHANGELOG migration entry + symlink warning in install output
  - Surfaced by: Pass 5 — Codex voice
  - Files: config.schema.json, commands/pipeline-init.md, bin/cli.js, CHANGELOG.md
  - Verify: v0.3-shape config triggers one-line note, nothing blocks
- [ ] **D8 (P3, human: ~30min / CC: ~5min)** — installer — backend-signal hygiene: drop --without-github inference, precedence rule, echo resolved backend
  - Surfaced by: Pass 2 — both voices
  - Files: bin/cli.js
  - Verify: smoke — flag>config precedence; echo line present
- [ ] **D9 (P3, human: ~30min / CC: ~5min)** — docs — merge-conflict recovery sequence in message + queue/README; B2 force-scan hatch documented
  - Surfaced by: Passes 2/3 — Claude #11, #12
  - Files: bin/cli.js, queue/README.md
  - Verify: conflict message names re-run path; smoke asserts idempotent re-run

## Decision Audit Trail (DX rows)

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|----------------|-----------|-----------|----------|
| 32 | DX | Persona: solo Claude Code dev trialing locally | Auto (P6 override) | P6 | README/npm evidence; matches trial-path framing | platform engineer persona |
| 33 | DX | Tier: Competitive (<5 min hello-world checkpoint), keep <10 min full-loop TTFT | Mechanical | P1,P5 | Codex pushed <5; checkpoint satisfies both without detector nondeterminism | Champion tier (hosted sandbox) |
| 34 | DX | Magical moment via copy-paste quickstart + demo script | Auto (P5 override) | P5 | lowest-effort vehicle hitting the tier; A7/A10 already in scope | hosted playground; video |
| 35 | DX | A7 expanded 1→7 items (README restructure, doc parity, framing fix) | Mechanical | P1 | both voices; README:186 + CLI-table drift verified | leave quickstart unspecified |
| 36 | DX | Deterministic hello world: quickstart seeds via ticket new | Mechanical | P1,P5 | TTFT was unfalsifiable resting on detector nondeterminism + spend | organic-intake-first quickstart |
| 37 | DX | Error-message contract (problem+cause+fix+key) | Mechanical | P1 | autoplan override: always require; "log line" is silence with extra steps | registry-only rescue |
| 38 | DX | A12 doctor verb added | Taste (expansion, auto-approved) | P2,P1 | <1 day, cli.js blast radius; trial-path triage surface | extend detect only; no triage verb |
| 39 | DX | ticket reopen <id> added to A9 | Mechanical | P4 | plan's own reopen story was "hand-move the file" — contradicts A9's purpose | document file-move as supported |
| 40 | DX | A3 accept-all-defaults fast path | Mechanical | P5 | 11-step wizard verified; override: fewer steps | full wizard always |
| 41 | DX | CLI grammar: nouns own create/show/reopen; diff/merge stay top-level (git mental model) | TASTE (auto, surfaced at gate) | P5 | consistency rule stated; mirrors git's own verbs | ticket merge <id> nesting (Codex) |
| 42 | DX | Drop --without github as backend signal; precedence + echo | Mechanical | P5 | dep≠backend (same category error eng fixed); surprising inference | keep clever inference |
| 43 | DX | configVersion + deprecation note + migration entry | Mechanical | P1 | upgrade-without-fear needs the tool to say what changed | rollback-only story |
| 44 | DX | modelTier values light\|standard | Mechanical | P5 | "default tier is default" circular in help text | light\|default |
| 45 | DX | run --local stays deferred (Codex challenge noted) | TASTE → final gate | P2,P3 | CEO deferral; quickstart mitigations land either way; wrapper drives a Claude session the CLI doesn't own | promote to scope now |
| 46 | DX | ticket new default state = needs-work (pre-triaged) | Mechanical | P5 | human-created ticket needs no agent triage; fastest path to magic | route through needs-review |
| 47 | DX | Community channel / CONTRIBUTING → TODOS | Mechanical | P2,P3 | only sub-8 dimension; ecosystem work, not this plan's scope | bundle into A7 |

## DX Completion Summary
```
+====================================================================+
|              DX PLAN REVIEW — COMPLETION SUMMARY                    |
+====================================================================+
| Mode                  | DX POLISH (autoplan override)              |
| Product type          | CLI tool + Claude Code plugin              |
| Persona               | solo Claude Code dev, local trial          |
| TTHW                  | ~12+ min (broken) → <5 min checkpoint      |
| Passes 1-8            | all run; 16 issues found, 14 folded,       |
|                       | 2 taste → gate; 1 deferred → TODOS         |
| Scorecard             | overall 8/10; only Community < 8 (TODOS)   |
| Journey map           | 6 stages, all friction points resolved     |
| Empathy narrative     | written (grounded in README:149,186)       |
| Confusion report      | written; all 7 points addressed            |
| Benchmark             | aider/OpenHands/Copilot + reference tiers  |
| Plugin DX checklist   | 6/6 patterns covered                       |
| Implementation tasks  | 9 (2 P1, 5 P2, 2 P3)                       |
| Outside voices        | ran (codex + claude subagent)              |
| Consensus             | 6/6 confirmed; 0 cross-model DISAGREEs     |
| Lake Score            | 16/16 recommendations chose complete       |
| Unresolved decisions  | 0 new blocking; 2 DX taste → final gate    |
+====================================================================+
```

---

# Cross-Phase Themes (autoplan synthesis)

1. **Direction survived every phase; mechanisms didn't.** No reviewer in three phases challenged *what* to build (premises held at the user gate) — but every phase found a load-bearing *how* bug: CEO found the loop dead-ends at `ready-for-human/` (→ A9), Eng found the install filter provably keeps gh-less machines broken and the intake wiring self-looping (→ A6/A1), DX found the TTFT metric unfalsifiable as written (→ deterministic seed). A plan can be strategically right and mechanically wrong in the same paragraph.
2. **One system, not two.** Three independent findings were the same mistake: ticket dedupe ignoring the shipped detector-fingerprint protocol (eng), `backends:["github"]` conflating dependency with backend (eng+DX), `--without github` as a backend signal (DX). The fix each time: reuse the existing taxonomy instead of inventing a parallel one.
3. **The trial path is the product.** CEO reframed local-only as every user's first ten minutes; Eng made it actually installable (waiver rule) and safe (merge guards); DX made it provable (<5-min checkpoint, quickstart with expected output, doctor). All three phases converged on the same north star metric without coordinating.
4. **Fail-safe must also speak.** Eng demanded both directions tested (B2 fail-open AND skip; cleanup refusal AND squash fallback); DX demanded every refusal name its fix (message contract). Rescue without a user-facing sentence is silence with extra steps.
5. **Measure before optimizing held up.** B0 (a CEO add) ended up carrying Eng's dispatch-path determination (B5's layer depends on it) and B4's placement decision — the cheapest item in the plan now de-risks the three most speculative ones.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | CLEAR (via /autoplan) | 7 proposals, 3 accepted, 3 deferred, 1 skipped; 0 critical gaps |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — (standalone skill not run; Codex voices ran inside all 3 autoplan phases — see CROSS-MODEL) | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN via /autoplan) | 15 issues, 0 critical gaps, all folded |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | skipped, no UI scope |
| DX Review | `/plan-devex-review` | Developer experience gaps | 1 | CLEAR (via /autoplan) | score: 5/10 → 8/10, TTHW: 12min → 5min |

- **CROSS-MODEL:** dual voices (Codex + Claude subagent) ran in all 3 phases — consensus 5/6 (CEO, 1 settled at user premise gate), 6/6 (Eng), 6/6 (DX); zero unresolved cross-model disagreements.
- **UNRESOLVED:** 0 — all 4 taste decisions resolved at the final gate (user approved as-is, 2026-06-10).
- **SHIP-STAGE ADVERSARIAL (2026-06-10, /ship pre-merge):** Claude subagent + Codex re-reviewed the final document; 15 findings fixed in place — dominant failure mode was *stale earlier-phase text contradicting later corrections* (Step 0E merge preflight, CEO diagram intake wiring), plus spec additions both models surfaced (B2 daily-minimum reconciliation, secret-redaction contract, priority numeric mapping, queue-stale lock parity, squash-fallback multi-commit limit, version-bump deliverable, A12 lane scheduling, path hygiene). Cross-model spot-checks confirmed all load-bearing codebase claims true.
- **VERDICT:** CEO + ENG + DX CLEARED — ready to implement.
