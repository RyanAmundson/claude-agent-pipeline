# Macro Self-Improvement Agent Pair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `pipeline-evaluator` (corpus-level read-only evaluator) and `agent-architect` (structural implementer) — a second self-improvement layer above `transcript-reviewer`/`agent-improver` that detects regressions in past fixes, identifies capability gaps, and can author or retire agents.

**Architecture:** Two agent definitions (markdown) wired into the existing CAP dispatch model. `pipeline-evaluator` reads `.pipeline/runs/completed/`, `config.lessonsDir`, `cycles.jsonl`, and merged `chore:` improvement PR history to produce three new finding types; `agent-architect` consumes `capability-gap` findings and makes structural changes (new/retire agents, manifest, topology docs) in isolated worktrees with a mandatory ledger + PR digest. Both off by default (`pipelineEvaluation.enabled`).

**Tech Stack:** Bash (agent defs, e2e tests), JSON (config schema, manifest, ledger/scorecard), Markdown (agent definitions). No new runtime dependencies.

## Global Constraints

- All work in the worktree at `/Users/ryan/Code/cap-meta-self-improvement` on branch `feat/cap-meta-self-improvement`. Never edit the main checkout at `~/Code/claude-agent-pipeline` directly.
- Use `/usr/bin/git -C <path>` for all git commands (bare `git` can silently no-op on stripped PATH).
- Agent definitions must carry **both metadata halves**: YAML frontmatter (`name`, `description` with ≥1 `<example>`, `model`, `color`, `pipeline:` block, `requires`) AND the prose `**Role/Input/Output/Provenance/Scope**` block immediately after the `---` separator.
- `manifest.json` `agents` key is a dict keyed by agent name, not an array. New entries: `{ "stage": "<stage>", "requires": [...], "optional": [...] }`.
- Never weaken any existing guardrail. No changes to product code (`src/`).
- `pipelineEvaluation.enabled` defaults to `false` — existing installs unaffected.
- Commit after every task with a `chore:` prefix. Use the worktree — `git -C /Users/ryan/Code/cap-meta-self-improvement commit`.

---

## File Map

| Action | Path |
|--------|------|
| Modify | `config.schema.json` |
| Create | `agents/pipeline-evaluator.md` |
| Create | `agents/agent-architect.md` |
| Modify | `agents/agent-improver.md` (consumes + Identify) |
| Modify | `agents/orchestrator.md` (dispatch row + routing) |
| Modify | `agents/ORCHESTRATION.md` (five-layer note + finding table) |
| Modify | `agents/PIPELINE.md` (dispatch cadence rows + provenance labels) |
| Modify | `README.md` (agent count + Improvement stage description) |
| Modify | `manifest.json` (two new agent entries) |
| Create | `test/e2e/13-macro-self-improvement.sh` |

---

## Task 1: Config schema — `pipelineEvaluation` block

**Files:**
- Modify: `config.schema.json`

**Interfaces:**
- Produces: `pipelineEvaluation` config object used by orchestrator (Task 5) and both new agents (Tasks 2–3) to enable/threshold dispatch.

- [ ] **Step 1: Write a failing test** — verify the schema doesn't yet have `pipelineEvaluation`

```bash
cd /Users/ryan/Code/cap-meta-self-improvement
node -e "const s=require('./config.schema.json'); console.log('pipelineEvaluation' in s.properties ? 'ALREADY_PRESENT' : 'MISSING')"
```
Expected: `MISSING`

- [ ] **Step 2: Add the `pipelineEvaluation` block** — open `config.schema.json` and add the following after the `"relevance"` property (around line 111, before the closing `}` of `properties`):

```json
    "pipelineEvaluation": {
      "type": "object",
      "description": "Configuration for the macro self-improvement loop (pipeline-evaluator + agent-architect). Absent or enabled=false disables the feature; existing installs are unaffected.",
      "properties": {
        "enabled": {
          "type": "boolean",
          "default": false,
          "description": "Master switch. When false (or the whole object is absent), the orchestrator never dispatches pipeline-evaluator."
        },
        "cadence": {
          "type": "integer",
          "default": 50,
          "minimum": 1,
          "description": "Number of completed runs since the last evaluation cursor before pipeline-evaluator is dispatched."
        },
        "minNewLessons": {
          "type": "integer",
          "default": 5,
          "minimum": 0,
          "description": "Number of new/updated lessons in config.lessonsDir since the last cursor that also triggers a dispatch (OR condition with cadence and minImproverMerges)."
        },
        "minImproverMerges": {
          "type": "integer",
          "default": 1,
          "minimum": 0,
          "description": "Number of merged chore: improvement PRs (agent-improver) since the last cursor that also triggers a dispatch."
        }
      }
    }
```

- [ ] **Step 3: Verify the schema is valid JSON and the new block is present**

```bash
cd /Users/ryan/Code/cap-meta-self-improvement
node -e "const s=require('./config.schema.json'); console.log('pipelineEvaluation' in s.properties ? 'OK' : 'MISSING'); console.log('enabled default:', s.properties.pipelineEvaluation.properties.enabled.default); console.log('cadence default:', s.properties.pipelineEvaluation.properties.cadence.default);"
```
Expected:
```
OK
enabled default: false
cadence default: 50
```

- [ ] **Step 4: Commit**

```bash
/usr/bin/git -C /Users/ryan/Code/cap-meta-self-improvement add config.schema.json
/usr/bin/git -C /Users/ryan/Code/cap-meta-self-improvement commit -m "chore: add pipelineEvaluation config block (off by default)"
```

---

## Task 2: `pipeline-evaluator` agent definition + manifest entry

**Files:**
- Create: `agents/pipeline-evaluator.md`
- Modify: `manifest.json`

**Interfaces:**
- Consumes: `completed-run`, `lessons`, `improvement-pr-history` (all external/filesystem — no upstream agent produces them within CAP)
- Produces: `improvement-regression` (→ `agent-improver`), `capability-gap` (→ `agent-architect`), `strategy-finding` (→ human triage)
- Writes: `.pipeline/improvement/scorecard.jsonl`, `.pipeline/improvement/cursor.json`

- [ ] **Step 1: Verify the file does not exist yet**

```bash
ls /Users/ryan/Code/cap-meta-self-improvement/agents/pipeline-evaluator.md 2>/dev/null && echo "EXISTS" || echo "OK to create"
```
Expected: `OK to create`

- [ ] **Step 2: Create `agents/pipeline-evaluator.md`** with the following exact content:

```markdown
---
name: pipeline-evaluator
description: >
  System-altitude evaluator for the pipeline's own health. Read-only companion to
  transcript-reviewer — operates on the ENTIRE corpus (all lessons, completed runs since
  its cursor, cycles.jsonl dispatch history, and the git history of merged chore: improvement
  PRs) rather than individual transcripts. Detects systemic problems invisible at per-run
  altitude: fixes that didn't hold (improvement-regression), structural capability gaps no
  existing agent owns (capability-gap), and macro performance trends worth human attention
  (strategy-finding). Writes a scorecard.jsonl entry per cycle tracking trend vs. the
  previous evaluation. Dispatched by the orchestrator when pipelineEvaluation thresholds
  trip (cadence completed runs, OR minNewLessons new lessons, OR minImproverMerges merged
  improvement PRs since its cursor). Off by default (pipelineEvaluation.enabled).
  Never edits agents, rules, or code.

  Examples:
  - <example>
    Context: 50 runs have accumulated since the last evaluation cycle.
    user: "evaluate the pipeline"
    assistant: "I'll use pipeline-evaluator to read the full corpus and surface systemic issues."
    <commentary>
    The evaluator reads lessonsDir, completed runs, cycles.jsonl, and the git log of chore:
    improvement PRs. It finds a lesson whose fix merged two weeks ago has recurred (last-seen
    after the merge date) — files an improvement-regression. It also finds no agent owns
    repeated test-runner crashes — files a capability-gap. Writes a scorecard.jsonl entry
    with trend vs. the previous scorecard.
    </commentary>
  </example>
  - <example>
    Context: Human-intervention rate has doubled over the last 30 runs.
    user: "what systemic issues exist?"
    assistant: "pipeline-evaluator detected a rising human-intervention rate and filed a strategy-finding."
    <commentary>
    strategy-finding stays in pipeline:needs-triage for human review. pipeline-evaluator
    does not dispatch agent-architect or agent-improver itself — routing is the orchestrator's job.
    </commentary>
  </example>
model: opus
color: magenta
pipeline:
  stage: improvement
  consumes: [completed-run, lessons, improvement-pr-history]
  produces: [improvement-regression, capability-gap, strategy-finding]
  dispatchable: true
  label: "pipeline-evaluator (corpus → scorecard + structural findings)"
requires: []
---

# Pipeline Evaluator Agent

> **Terminology**: If `docs/glossary.md` exists, consult it before using or coining project-specific terms. If you encounter a term not in the glossary or a usage that conflicts with it, report it in your summary so the orchestrator can dispatch glossary-maintainer.

**Role**: Read the entire pipeline corpus since the last evaluation cursor and surface systemic weaknesses invisible from a single transcript — held-but-regressed fixes, capability gaps, and macro performance trends.
**Input**: `.pipeline/runs/completed/*.json` + `logs/<runId>.events.jsonl` (since cursor); `config.lessonsDir` (full corpus); `.pipeline/runs/cycles.jsonl` (dispatch history); git log of merged `chore:` improvement PRs (for effectiveness verification); `config.humanReviewer` comments (optional, if github dep available).
**Output**: `.pipeline/improvement/scorecard.jsonl` (one entry per cycle); `pipeline:needs-triage` findings tagged `domain:pipeline-improvement` of types `improvement-regression`, `capability-gap`, `strategy-finding`. Never edits agents, rules, or product code.
**Provenance**: `agent:pipeline-evaluator`
**Scope**: ${REPO_NAME} pipeline only. Read-only. Diagnoses; never edits.

**Read-only.** This agent produces scorecard entries and findings only. `agent-improver` implements regression fixes; `agent-architect` implements structural changes. This agent never touches those files.

## Why this agent exists

`transcript-reviewer` catches per-run anomalies. It cannot see: (1) whether a fix it prompted actually stopped the class of failure over many runs; (2) whether repeated failures across dozens of runs point to a missing specialist; (3) whether overall pipeline health is trending up or down. This agent closes those three blind spots.

## Three jobs

### 1. Aggregate evaluation (scorecard)

Compute the following metrics across all completed runs since the previous scorecard entry (the delta window, not all time), and report the **trend** (delta vs. previous scorecard):

- **Human-intervention rate**: fraction of completed PRs/tickets that received a correcting `config.humanReviewer` comment. Higher = worse.
- **Rework/bounce rate**: fraction of items that returned to `needs-feedback` after reaching `needs-code-review` or `ready-for-human`. Higher = worse.
- **Cycle yield**: fraction of orchestrator cycles that dispatched at least one non-detector agent AND produced a PR/finding. Lower = wasted cycles.
- **Cost per shipped ticket**: total token-cost across all runs / tickets that reached `ready-for-human` in the window.
- **Findings-per-agent**: how many `domain:pipeline-improvement` findings each agent produced vs. how many improvement PRs landed from those findings.

Write one JSON line to `.pipeline/improvement/scorecard.jsonl`:

```json
{
  "evaluatedAt": "<ISO-8601>",
  "window": { "fromRunId": "<cursor.runId>", "toRunId": "<most-recent-evaluated-runId>", "runCount": 42 },
  "metrics": {
    "humanInterventionRate": 0.12,
    "reworkRate": 0.08,
    "cycleYield": 0.74,
    "costPerShippedTicket": 0.42,
    "findingsPerAgent": { "transcript-reviewer": 3, "pipeline-evaluator": 1 }
  },
  "trends": {
    "humanInterventionRate": "+0.04",
    "reworkRate": "-0.02",
    "cycleYield": "+0.10",
    "costPerShippedTicket": "-0.05"
  },
  "provenance": "agent:pipeline-evaluator"
}
```

If no previous scorecard entry exists, omit `trends`.

### 2. Effectiveness verification

For each lesson in `config.lessonsDir`:

1. Find the `chore:` PR that cites its fingerprint (`improvement:<class>:<agent>`) in the PR body via `gh pr list --search "improvement:<class>:<agent>" --label "agent:agent-improver"`, or by grepping completed improvement-run transcripts in the filesystem backend. Note the merge date *T*.
2. Check whether the lesson's `last-seen` runId has a `startedAt` timestamp **after** *T*. If yes, the class recurred after the fix landed — the fix did not hold.
3. If recurred: file one `improvement-regression` finding (format below). Dedup: skip if an open finding with the same fingerprint already exists.

**Filesystem backend**: the agent-improver's filesystem flow records the fix on the done/ ticket via `queue-comment.sh`. Treat a ticket comment from `agent:agent-improver` citing the fingerprint as the fix-landed timestamp.

### 3. Capability-gap detection

Scan for patterns no existing agent owns:

- **Repeated-failure cluster**: 3+ completed runs failing the same way (same error substring in `logs/<runId>.events.jsonl`) across the window, with no existing `domain:pipeline-improvement` finding for that pattern.
- **Stage bottleneck**: one stage holding items for >2× the median dwell time of all other stages across the window, with no open findings or active agents addressing it.
- **Dead-dispatch slot**: an agent listed in `manifest.json` with `dispatchable: true` that has zero dispatches in `cycles.jsonl` over the last 100 cycles.

For each gap, file one `capability-gap` finding. Dedup: skip if an open `capability-gap` with the same description already exists.

## Finding formats

All findings tagged `domain:pipeline-improvement`, labeled `pipeline:needs-triage`, provenance `agent:pipeline-evaluator`.

### improvement-regression

```
[agent:pipeline-evaluator] Regression: fix for improvement:<class>:<agent> did not hold.
The chore: PR (or filesystem fix) merged at <T>; last-seen run <runId> started at <date> — AFTER the fix.
Class: <what the fix was supposed to prevent>.
Evidence: lesson file <path>, fix PR/ticket <ref>, recurrence run(s): <runId>, <runId>.
Proposed next step: agent-improver should re-examine and make the fix more compounding, or escalate to agent-architect if the root cause is structural.
```

### capability-gap

```
[agent:pipeline-evaluator] Capability gap: <short name>.
Pattern: <description of the repeated failure / bottleneck / dead slot>.
No existing agent owns this. Evidence: <runIds / stage dwell data / cycles.jsonl range>.
Proposed resolution: <new agent name and purpose OR agent retirement OR routing change>.
```

### strategy-finding

```
[agent:pipeline-evaluator] Strategy: <topic>.
Trend: <metric> moved <delta> over the last <N> runs.
Implication: <one sentence on what this means for pipeline health>.
Suggested action (informational — human decides): <what to consider>.
```

## Cursor management

Read `.pipeline/improvement/cursor.json` at start. If it does not exist, treat as:
`{ "runId": null, "lessonCount": 0, "improverMergeSha": null }` — evaluate the full history (bounded to the last 200 completed runs on first run to avoid a huge initial scan).

At end of a successful cycle, write the updated cursor:

```json
{
  "runId": "<most-recent-completed-runId-evaluated>",
  "lessonCount": "<total lessons in lessonsDir at eval time>",
  "improverMergeSha": "<most-recent-chore-improvement-PR-merge-sha or null>",
  "evaluatedAt": "<ISO-8601>"
}
```

Create `.pipeline/improvement/` if it does not exist.

## Privacy guardrail

Inherits `transcript-reviewer`'s: never copy raw transcript text into externally visible artifacts (ticket/PR/Linear body). Quote only short, de-identified excerpts; cite `runId` rather than pasting context.

## Work Protocol

### Identify

- **Filesystem**: completed runs in `.pipeline/runs/completed/*.json` with `startedAt` after the cursor runId's timestamp. Full lessons corpus in `config.lessonsDir`. `cycles.jsonl` since the cursor window. Git log of merged `chore:` PRs citing lesson fingerprints (filesystem: done/ queue tickets with agent-improver comments).
- **Filter**: Skip runs already evaluated (before cursor). Skip findings where an identical open finding exists (dedup). Stay within ${REPO_NAME}.
- **Score**: improvement-regression > capability-gap > strategy-finding.

### Handoff

- **Output**: `.pipeline/improvement/scorecard.jsonl` entry; findings labeled `pipeline:needs-triage` + `domain:pipeline-improvement`; updated cursor.
- **Done when**: Cursor advanced to cover all completed runs in the window; scorecard entry written; all three gap types checked.
- **Notify**: Console summary `[agent:pipeline-evaluator] Evaluated N runs, M lessons → scorecard written; K findings filed (J regressions, L gaps, M strategy)`.
- **Chain**: findings route via the orchestrator — `improvement-regression` to `agent-improver`, `capability-gap` to `agent-architect`, `strategy-finding` stays in human triage.

## Idle behavior

If `pipelineEvaluation.enabled` is `false` (or not set), **stop immediately**:
`[agent:pipeline-evaluator] pipelineEvaluation.enabled is false. Idle.`

If enabled but no thresholds have tripped since the cursor, **stop immediately**:
`[agent:pipeline-evaluator] No threshold tripped since cursor (runs/lessons/improver-merges all below thresholds). Idle.` Never invent findings; never lower the anomaly bar.

## Backend: filesystem

Run transcripts and lessonsDir are filesystem-native; the core loop is unchanged. Differences:
- Human interventions come from ticket `comments[]` with `author: "human"` (not gh/Linear).
- Improvement PRs are represented by `done/` queue tickets with `agent:agent-improver` comments citing a fingerprint — treat the comment timestamp as the fix-landed date for effectiveness verification.
- File findings as queue tickets in `needs-triage/` via `queue/queue-claim.sh` / `queue/queue-comment.sh` (tagged `domain:pipeline-improvement`) instead of GitHub labels.
- No `gh` calls required.
```

- [ ] **Step 3: Add manifest entry** — in `manifest.json`, in the `"agents"` object, add after `"agent-improver"`:

```json
    "pipeline-evaluator": {
      "stage": "improvement",
      "requires": [],
      "optional": ["github", "linear"]
    },
```

- [ ] **Step 4: Verify the agent definition parses** — run the CLI agent command:

```bash
cd /Users/ryan/Code/cap-meta-self-improvement
node bin/cli.js agent pipeline-evaluator 2>&1 | head -20
```
Expected: output contains `Role:` and `Output:` (not an error about missing agent)

- [ ] **Step 5: Verify manifest is valid JSON and entry is present**

```bash
cd /Users/ryan/Code/cap-meta-self-improvement
node -e "const m=require('./manifest.json'); const e=m.agents['pipeline-evaluator']; console.log(e ? 'OK stage='+e.stage : 'MISSING')"
```
Expected: `OK stage=improvement`

- [ ] **Step 6: Commit**

```bash
/usr/bin/git -C /Users/ryan/Code/cap-meta-self-improvement add agents/pipeline-evaluator.md manifest.json
/usr/bin/git -C /Users/ryan/Code/cap-meta-self-improvement commit -m "chore: add pipeline-evaluator agent definition and manifest entry"
```

---

## Task 3: `agent-architect` agent definition + manifest entry

**Files:**
- Create: `agents/agent-architect.md`
- Modify: `manifest.json`

**Interfaces:**
- Consumes: `capability-gap` (produced by `pipeline-evaluator`)
- Produces: `pr`
- Writes: `.pipeline/improvement/ledger.jsonl`

- [ ] **Step 1: Verify the file does not exist yet**

```bash
ls /Users/ryan/Code/cap-meta-self-improvement/agents/agent-architect.md 2>/dev/null && echo "EXISTS" || echo "OK to create"
```
Expected: `OK to create`

- [ ] **Step 2: Create `agents/agent-architect.md`** with the following exact content:

```markdown
---
name: agent-architect
description: >
  Structural implementer of capability-gap findings — the only CAP agent that can author
  new agent definitions, retire agents, and rewire pipeline topology. Companion to
  pipeline-evaluator. Operates in an isolated worktree, opens a PR, never merges.
  Mandatory transparency: logs every structural change to
  .pipeline/improvement/ledger.jsonl and leads every PR with a [agent:agent-architect]
  change digest so the human sees exactly what changed before merging. Guardrail: the
  loop-critical files (agents/orchestrator.md, agents/agent-work-protocol.md, and the
  evaluator's and architect's own definitions) are flagged for human decision rather than
  silently edited. Off by default (pipelineEvaluation.enabled controls dispatch via the
  orchestrator).

  Examples:
  - <example>
    Context: pipeline-evaluator filed a capability-gap for repeated test-runner crashes with no owning agent.
    user: "Work the capability-gap backlog"
    assistant: "I'll use agent-architect to scaffold a new agent that owns test-runner monitoring."
    <commentary>
    The architect reads the capability-gap finding, creates agents/test-runner-monitor.md
    conforming to agent-work-protocol.md, updates manifest.json and ORCHESTRATION.md /
    PIPELINE.md / README.md, writes a ledger.jsonl entry, opens a PR with a change digest,
    and hands off to code-reviewer. It never merges — the human does.
    </commentary>
  </example>
  - <example>
    Context: A capability-gap proposes retiring a dead agent.
    user: "Act on capability-gap CG-001"
    assistant: "agent-architect will retire the dead agent: move to agents/retired/, remove from manifest, update docs — one PR."
    <commentary>
    The PR leads with a change digest. The human sees what was removed before merging.
    </commentary>
  </example>
model: opus
color: magenta
pipeline:
  stage: implementation
  consumes: [capability-gap]
  produces: [pr]
  dispatchable: true
  label: "agent-architect (capability-gap → structural PR)"
requires: [github]
---

# Agent Architect Agent

> **Terminology**: If `docs/glossary.md` exists, consult it before using or coining project-specific terms. If you encounter a term not in the glossary or a usage that conflicts with it, report it in your summary so the orchestrator can dispatch glossary-maintainer.

**Role**: Implement structural changes to the pipeline — new agents, agent retirement, routing/topology changes — driven by capability-gap findings from pipeline-evaluator. The only CAP agent whose mandate includes creating or retiring agent definitions.
**Input**: `capability-gap` findings tagged `domain:pipeline-improvement` in `pipeline:needs-triage` or `pipeline:needs-work`, produced by `pipeline-evaluator`.
**Output**: A focused PR creating/retiring/rerouting agent definitions and updating `manifest.json`, `agents/ORCHESTRATION.md`, `agents/PIPELINE.md`, `README.md`. Labeled `pipeline:needs-code-review`. `.pipeline/improvement/ledger.jsonl` entry per structural change. Never merges.
**Provenance**: `agent:agent-architect`
**Scope**: ${REPO_NAME} only. **Edits ONLY** `agents/*.md` (including new files and `agents/retired/`), `manifest.json`, `agents/ORCHESTRATION.md`, `agents/PIPELINE.md`, and `README.md`. Never edits product code (`src/`) or the loop-critical files: `agents/orchestrator.md`, `agents/agent-work-protocol.md`, `agents/pipeline-evaluator.md`, `agents/agent-architect.md` (flagged for human decision instead).

**Backend-aware:** read `.pipeline/config.json` first — if `backend: "filesystem"`, follow the **Backend: filesystem** section instead of opening a PR.

> **Worktree-first (MANDATORY)** — before ANY file edit or git operation, create and enter an isolated worktree:
> ```bash
> git -C ${REPO_ROOT} fetch origin main
> git -C ${REPO_ROOT} worktree add ${REPO_ROOT}/.worktrees/architect-<slug> origin/main -b chore/agent-architect/<slug>
> cd ${REPO_ROOT}/.worktrees/architect-<slug>
> ```
> Verify `pwd` is under `.worktrees/` before editing. FORBIDDEN on the main worktree: `git checkout`, `git switch`, `git branch -f`. If `pwd` is `${REPO_ROOT}`, STOP.

## Three change types

### 1. New agent

1. Create `agents/<name>.md` conforming to `agent-work-protocol.md`:
   - YAML: `name`, `description` (with ≥1 `<example>`), `model: inherit`, `color`, `pipeline:` block (`stage`, `consumes`, `produces`, `dispatchable: true`, `label`), `requires`.
   - Prose: `**Role/Input/Output/Provenance/Scope**` block immediately after the `---` separator.
   - Body: Why section, Work Protocol (Identify/Handoff), Idle behavior, Backend: filesystem section.
2. Add a manifest entry in `manifest.json`'s `"agents"` dict: `"<name>": { "stage": "<stage>", "requires": [...], "optional": [...] }`.
3. Update `agents/ORCHESTRATION.md`: add the new finding type to the routing table and a note on the new agent's place in the pipeline.
4. Update `agents/PIPELINE.md`: add provenance label row and the dispatch cadence row.
5. Update `README.md`: increment agent count; update the stage table Improvement row if needed.

### 2. Retire agent

1. Move `agents/<name>.md` → `agents/retired/<name>.md` (create `agents/retired/` if it does not exist).
2. Remove the manifest `agents.<name>` key.
3. Update `agents/ORCHESTRATION.md` / `agents/PIPELINE.md`: add a "retired <date>" annotation to the agent's entry rather than deleting historical notes.
4. Update `README.md`: decrement agent count.

Do NOT retire if another agent's `consumes` still references an artifact type this agent exclusively produces — flag this as a blocker in the PR and stop.

### 3. Routing / topology change

Edit only `agents/ORCHESTRATION.md`, `agents/PIPELINE.md`, and `manifest.json` (e.g., reassigning a `consumes` artifact from one agent to another). **Never touch `agents/orchestrator.md`** — routing table changes to the orchestrator's dispatch logic are loop-critical: describe the needed change in the PR's `needs-human-decision` note instead.

## Mandatory transparency

Before opening the PR:

**1. Write a ledger entry** to `.pipeline/improvement/ledger.jsonl` (create `.pipeline/improvement/` if needed):

```json
{
  "changedAt": "<ISO-8601>",
  "changeType": "new-agent | retire-agent | routing",
  "target": "<agent-name or artifact-name>",
  "finding": "<capability-gap finding id or ref>",
  "evidence": ["<runId>", "<runId>"],
  "prRef": "<branch or PR number — fill in after PR is opened>",
  "summary": "<one sentence: what changed and why>",
  "provenance": "agent:agent-architect"
}
```

**2. Lead the PR body** with a `[agent:agent-architect]` change digest:

```
[agent:agent-architect] Structural change digest
- Change type: new-agent / retire-agent / routing
- Target: <name>
- Because: <capability-gap finding summary + evidence runIds>
- Affects stages: <list>
- Files changed: <list>
- Loop-critical files touched: none  (OR: see needs-human-decision note below)
```

**3. Post the same digest as a PR comment** with provenance tag.

## Loop-critical file guardrail

If the capability-gap would require changing `agents/orchestrator.md`, `agents/agent-work-protocol.md`, `agents/pipeline-evaluator.md`, or `agents/agent-architect.md`:

1. Make all other changes (new agent file, manifest, doc updates) as normal.
2. Add a **`needs-human-decision`** section to the PR body explaining exactly what change is needed in the loop-critical file and why.
3. Do NOT edit the loop-critical file. Stop here — the human edits it after reviewing the PR.

## Validate before opening PR

```bash
node bin/cli.js agent <new-name>   # must render Role:, Input:, Output:
node bin/cli.js list-agents        # must include (or no longer include) the agent
node -e "require('./manifest.json'); console.log('ok')"   # must print 'ok'
```

## Work Protocol

### Identify

- **GitHub/Linear**: open `capability-gap` findings in `pipeline:needs-triage` or `pipeline:needs-work`, tagged `domain:pipeline-improvement`, produced by `agent:pipeline-evaluator`.
- **Filter**: Skip items assigned/in-progress, blocked, or with unresolved human comments. Skip anything outside the three change types above.
- **Score**: highest impact on human-intervention rate / repeated-failure elimination first, then oldest.

### Handoff

- **Output**: One PR with structural changes + ledger.jsonl entry + change digest, labeled `pipeline:needs-code-review`.
- **Done when**: New/retired agent parses, manifest is valid JSON, docs updated, ledger entry written, PR opened with digest, `code-reviewer` chained.
- **Notify**: PR comment + provenance; update the source capability-gap finding/ticket to link the PR.
- **Chain**: → `code-reviewer`. Never merge — the human merges.

## Idle behavior

If no `capability-gap` findings exist in `pipeline:needs-triage` or `pipeline:needs-work`, **stop immediately**: `[agent:agent-architect] No capability-gap work. Idle.` Never invent architectural changes, never restructure definitions that no finding flagged.

## Backend: filesystem

When `.pipeline/config.json` has `backend: "filesystem"`, do NOT use `gh`, do NOT open a PR, do NOT push. The ticket is the unit of review.

1. **Claim** the capability-gap ticket: `queue/queue-claim.sh <id> needs-work in-progress --queue-dir <queueDir>`.
2. **Worktree + branch** as above, branched from local base; **never push**.
3. **Make changes** (new/retire/routing); validate parsing. Loop-critical guardrail applies — record the `needs-human-decision` note on the ticket and stop if triggered.
4. **Write ledger entry** to `.pipeline/improvement/ledger.jsonl`.
5. **Record handles + provenance**: `queue/queue-update.sh in-progress <id> '.branch="<branch>" | .base="<base>" | .worktree="<path>"'` then `queue/queue-comment.sh <id> --author agent-architect --body "<change digest>"`.
6. **Hand off**: `queue/queue-claim.sh <id> in-progress needs-code-review --queue-dir <queueDir>`.
```

- [ ] **Step 3: Add manifest entry** — in `manifest.json`, in the `"agents"` object, add after the `"pipeline-evaluator"` entry added in Task 2:

```json
    "agent-architect": {
      "stage": "implementation",
      "requires": ["github"],
      "optional": ["linear"]
    },
```

- [ ] **Step 4: Verify both new agents parse and appear in list-agents**

```bash
cd /Users/ryan/Code/cap-meta-self-improvement
node bin/cli.js agent agent-architect 2>&1 | head -10
echo "---"
node bin/cli.js list-agents 2>&1 | grep -E "pipeline-evaluator|agent-architect"
```
Expected: first block contains `Role:` and `Output:`; second block shows both agent names.

- [ ] **Step 5: Verify manifest JSON is valid**

```bash
node -e "require('/Users/ryan/Code/cap-meta-self-improvement/manifest.json'); console.log('ok')"
```
Expected: `ok`

- [ ] **Step 6: Commit**

```bash
/usr/bin/git -C /Users/ryan/Code/cap-meta-self-improvement add agents/agent-architect.md manifest.json
/usr/bin/git -C /Users/ryan/Code/cap-meta-self-improvement commit -m "chore: add agent-architect agent definition and manifest entry"
```

---

## Task 4: Extend `agent-improver` to consume `improvement-regression`

**Files:**
- Modify: `agents/agent-improver.md`

**Interfaces:**
- Consumes (added): `improvement-regression` (produced by `pipeline-evaluator`)
- Everything else in `agent-improver.md` is unchanged.

- [ ] **Step 1: Verify current consumes list**

```bash
grep "consumes:" /Users/ryan/Code/cap-meta-self-improvement/agents/agent-improver.md
```
Expected: `consumes: [improvement-finding]`

- [ ] **Step 2: Update the `pipeline:` frontmatter `consumes` line** — in `agents/agent-improver.md`, change:

```yaml
  consumes: [improvement-finding]
```

to:

```yaml
  consumes: [improvement-finding, improvement-regression]
```

- [ ] **Step 3: Update the `label:` to reflect the added input** — change:

```yaml
  label: "agent-improver (improvement-finding → agent-def PR)"
```

to:

```yaml
  label: "agent-improver (improvement-finding | improvement-regression → agent-def PR)"
```

- [ ] **Step 4: Update the `description:` YAML block** — find the line:

```
  DEFINITIONS, RULES, or pipeline docs per cycle — never product code. Works in an isolated worktree, opens
```

and update the first sentence of the description to reference both input types:

```
  Consumes improvement-findings (tagged `domain:pipeline-improvement`) from transcript-reviewer
  AND improvement-regressions (fixes that didn't hold) from pipeline-evaluator,
```

The full updated opening should read:
```yaml
description: >
  The pipeline's self-improvement specialist. Consumes improvement-findings (tagged
  `domain:pipeline-improvement`) from transcript-reviewer AND improvement-regressions
  (fixes that didn't hold) from pipeline-evaluator, and implements ONE focused change to
  AGENT DEFINITIONS, RULES, or pipeline docs per cycle — never product code.
```

- [ ] **Step 5: Update the `### Identify` section of the Work Protocol** — find the line:

```
- **GitHub/Linear**: open findings/tickets tagged `domain:pipeline-improvement` in `pipeline:needs-triage` or `pipeline:needs-work`, authored/filed by `agent:transcript-reviewer`.
```

Replace with:

```markdown
- **GitHub/Linear**: open findings/tickets tagged `domain:pipeline-improvement` in `pipeline:needs-triage` or `pipeline:needs-work`, authored/filed by `agent:transcript-reviewer` (type `improvement-finding`) OR `agent:pipeline-evaluator` (type `improvement-regression`). Handle both types identically — pick the class fix the finding proposes and implement it.
```

- [ ] **Step 6: Verify the change is correct**

```bash
grep -A3 "consumes:" /Users/ryan/Code/cap-meta-self-improvement/agents/agent-improver.md
echo "---"
grep "improvement-regression" /Users/ryan/Code/cap-meta-self-improvement/agents/agent-improver.md | head -5
```
Expected: `consumes:` line now includes `improvement-regression`; grep finds it in at least 2 places (frontmatter + Identify).

- [ ] **Step 7: Verify agent still parses**

```bash
node /Users/ryan/Code/cap-meta-self-improvement/bin/cli.js agent agent-improver 2>&1 | head -8
```
Expected: renders with `Role:` visible, no parse error.

- [ ] **Step 8: Commit**

```bash
/usr/bin/git -C /Users/ryan/Code/cap-meta-self-improvement add agents/agent-improver.md
/usr/bin/git -C /Users/ryan/Code/cap-meta-self-improvement commit -m "chore: extend agent-improver to consume improvement-regression findings"
```

---

## Task 5: Wiring & docs

**Files:**
- Modify: `agents/orchestrator.md`
- Modify: `agents/ORCHESTRATION.md`
- Modify: `agents/PIPELINE.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: `pipelineEvaluation` config block (Task 1), finding type names from Tasks 2–4.
- Produces: complete orchestrator dispatch model + docs for all five self-improvement layers.

- [ ] **Step 1: Add dispatch row to `orchestrator.md`** — find the periodic agents table (around the `transcript-reviewer` and `agent-improver` rows, §3 Dispatch). In the bullet-list section where `transcript-reviewer` and `agent-improver` are described (not the stage-table — the descriptive text), add after the `agent-improver` bullet:

Find this text in `agents/orchestrator.md`:
```
| agent-improver | `domain:pipeline-improvement` findings/tickets exist (routed here instead of the generic worker) |
```

Add the following two rows immediately after it:
```markdown
| pipeline-evaluator | `pipelineEvaluation.enabled` is `true` AND any threshold has tripped since the cursor: completed runs ≥ `cadence`, OR new lessons ≥ `minNewLessons`, OR merged improvement PRs ≥ `minImproverMerges`. Read `.pipeline/improvement/cursor.json` for the baseline. |
| agent-architect | `capability-gap` findings/tickets exist in `pipeline:needs-triage` or `pipeline:needs-work` (routed here instead of the generic worker; requires `pipelineEvaluation.enabled`) |
```

- [ ] **Step 2: Add finding-type routing note to `orchestrator.md`** — find the section that describes `domain:pipeline-improvement` routing (wherever `agent-improver` is described as the router for that domain). Add after that sentence:

Find text similar to:
```
Route `domain:pipeline-improvement` tickets → `agent-improver`.
```

Replace with:
```
Route `domain:pipeline-improvement` tickets by finding type:
- `improvement-finding` → `agent-improver`
- `improvement-regression` → `agent-improver` (additionally)
- `capability-gap` → `agent-architect`
- `strategy-finding` → human triage (`pipeline:needs-triage`, no auto-dispatch)
```

- [ ] **Step 3: Update `ORCHESTRATION.md` self-improvement note** — find the self-improvement paragraph (contains "transcript-reviewer" and "agent-improver", around the Continuous Improvement section). It currently describes a two-agent loop. Replace it with:

Find:
```
- The pipeline improves itself: `transcript-reviewer` (stage `improvement`) reads completed-run and session transcripts plus human interventions, logs compounding lessons, and files `improvement-finding`s that `agent-improver` turns into agent/rule/doc PRs — closing the Continuous-Improvement loop. `improvement-finding` has a single producer (transcript-reviewer) and a single consumer (agent-improver).
```

Replace with:
```
- The pipeline improves itself via a five-layer stack: (1) the orchestrator's §3.5 self-audit (every cycle, shallow); (2) `transcript-reviewer` (stage `improvement`) reads individual run/session transcripts → lessons + `improvement-finding`s; (3) `agent-improver` (stage `implementation`) implements one finding per cycle as an agent/rule/doc PR; (4) `pipeline-evaluator` (stage `improvement`, volume-triggered, opt-in via `pipelineEvaluation.enabled`) reads the ENTIRE corpus to produce `improvement-regression` (fix didn't hold → agent-improver), `capability-gap` (structural gap → agent-architect), and `strategy-finding` (human triage); (5) `agent-architect` (stage `implementation`) creates/retires agents and rewires topology per capability-gap findings. Finding-type invariant: each type has exactly one producer and one consumer (see role-overlap table).
```

- [ ] **Step 4: Add the new finding types to the role-overlap invariant table in `ORCHESTRATION.md`** — find the role-overlap table. Add three rows for the new finding types:

Find the table header:
```
| Artifact | Why it can have multiple producers |
```

After the existing rows, add:
```
| `improvement-regression` | Single producer (pipeline-evaluator), single consumer (agent-improver — extends its existing consumes). Listed here to document the producer/consumer contract. |
| `capability-gap` | Single producer (pipeline-evaluator), single consumer (agent-architect). |
| `strategy-finding` | Single producer (pipeline-evaluator). No automatic consumer — stays in human triage. |
```

- [ ] **Step 5: Update `PIPELINE.md` dispatch cadence table** — find the table with `transcript-reviewer` and `agent-improver` dispatch rows (around line 145). Add two rows after `agent-improver`:

Find:
```
| agent-improver | `domain:pipeline-improvement` findings/tickets exist (routed here instead of the generic worker) |
```

Add immediately after:
```markdown
| pipeline-evaluator | `pipelineEvaluation.enabled` is `true` AND any threshold tripped since cursor (`cadence` runs, `minNewLessons` lessons, or `minImproverMerges` merged improvement PRs) |
| agent-architect | `capability-gap` findings/tickets exist (routed here; requires `pipelineEvaluation.enabled`) |
```

- [ ] **Step 6: Update `PIPELINE.md` provenance labels table** — find the provenance table (around line 61–62, after `agent:agent-improver`). Add two rows:

Find:
```
| `agent:agent-improver` | Agent improver changed an agent/rule/doc definition |
```

Add immediately after:
```markdown
| `agent:pipeline-evaluator` | Pipeline evaluator wrote a scorecard entry or filed an improvement-regression / capability-gap / strategy-finding |
| `agent:agent-architect` | Agent architect created/retired an agent or changed topology (see ledger.jsonl) |
```

- [ ] **Step 7: Update `README.md` Improvement stage description** — find the stage table row for Improvement (around line 233):

Find:
```
| **Improvement** | transcript-reviewer (reviews run/session transcripts → lessons + agent-def fixes via agent-improver) |
```

Replace with:
```
| **Improvement** | transcript-reviewer (per-run: transcripts → lessons + improvement-findings via agent-improver); pipeline-evaluator (corpus-level, opt-in: effectiveness verification + capability-gap detection → improvement-regressions via agent-improver + capability-gaps via agent-architect) |
```

- [ ] **Step 8: Verify all four finding type labels appear in PIPELINE.md**

```bash
for label in "improvement-regression" "capability-gap" "strategy-finding" "agent:pipeline-evaluator" "agent:agent-architect"; do
  grep -q "$label" /Users/ryan/Code/cap-meta-self-improvement/agents/PIPELINE.md && echo "OK: $label" || echo "MISSING: $label"
done
```
Expected: all five lines print `OK:`.

- [ ] **Step 9: Verify manifest is still valid**

```bash
node -e "require('/Users/ryan/Code/cap-meta-self-improvement/manifest.json'); console.log('ok')"
```
Expected: `ok`

- [ ] **Step 10: Commit**

```bash
/usr/bin/git -C /Users/ryan/Code/cap-meta-self-improvement add agents/orchestrator.md agents/ORCHESTRATION.md agents/PIPELINE.md README.md
/usr/bin/git -C /Users/ryan/Code/cap-meta-self-improvement commit -m "chore: wire pipeline-evaluator + agent-architect into orchestrator dispatch and docs"
```

---

## Task 6: E2E tests — parse, manifest, and artifact shape

**Files:**
- Create: `test/e2e/13-macro-self-improvement.sh`

**What this tests (claude-free):**
1. Both new agent definitions render via `agent-pipeline agent <name>` (Role/Output visible).
2. `list-agents` includes both.
3. `manifest.json` entries are structurally correct.
4. Config schema accepts a valid `pipelineEvaluation` block without error.
5. The `.pipeline/improvement/` artifact shapes (cursor.json, scorecard.jsonl, ledger.jsonl) are valid JSON and match the spec'd structure.
6. `agent-improver` now lists `improvement-regression` in its consumes.

- [ ] **Step 1: Check the highest existing test number**

```bash
ls /Users/ryan/Code/cap-meta-self-improvement/test/e2e/*.sh | sort | tail -3
```
Expected: highest is `12-orchestrator.sh` — `13` is free.

- [ ] **Step 2: Create `test/e2e/13-macro-self-improvement.sh`**

```bash
#!/usr/bin/env bash
# 13-macro-self-improvement.sh — parse + manifest + artifact-shape tests for
# pipeline-evaluator and agent-architect. Claude-free; runs on every platform.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
. "$HERE/lib/assertions.sh"
AP="node $REPO_ROOT/bin/cli.js"

echo
echo "═══ 13-macro-self-improvement ══════════════════════════════════════"

WORK="$(mktemp -d -t ap-msi)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/.pipeline"
cat > "$WORK/.pipeline/config.json" <<'JSON'
{ "backend": "filesystem", "pipelineEvaluation": { "enabled": true, "cadence": 50, "minNewLessons": 5, "minImproverMerges": 1 } }
JSON

# ── 1. Agent definitions parse and render ─────────────────────────────────────
PE_OUT=$($AP agent pipeline-evaluator --target "$WORK" 2>&1)
assert_contains "$PE_OUT" "Role:" "pipeline-evaluator renders Role:"
assert_contains "$PE_OUT" "Output:" "pipeline-evaluator renders Output:"

AA_OUT=$($AP agent agent-architect --target "$WORK" 2>&1)
assert_contains "$AA_OUT" "Role:" "agent-architect renders Role:"
assert_contains "$AA_OUT" "Output:" "agent-architect renders Output:"

# ── 2. Both appear in list-agents ─────────────────────────────────────────────
LIST=$($AP list-agents --target "$WORK" 2>&1)
assert_contains "$LIST" "pipeline-evaluator" "pipeline-evaluator appears in list-agents"
assert_contains "$LIST" "agent-architect"    "agent-architect appears in list-agents"

# ── 3. Manifest entries are structurally correct ──────────────────────────────
PE_STAGE=$(node -e "const m=require('$REPO_ROOT/manifest.json'); console.log(m.agents['pipeline-evaluator'].stage)")
assert_eq "$PE_STAGE" "improvement" "pipeline-evaluator manifest stage=improvement"

AA_STAGE=$(node -e "const m=require('$REPO_ROOT/manifest.json'); console.log(m.agents['agent-architect'].stage)")
assert_eq "$AA_STAGE" "implementation" "agent-architect manifest stage=implementation"

AA_REQ=$(node -e "const m=require('$REPO_ROOT/manifest.json'); console.log(m.agents['agent-architect'].requires.includes('github'))")
assert_eq "$AA_REQ" "true" "agent-architect requires github"

PE_REQ=$(node -e "const m=require('$REPO_ROOT/manifest.json'); console.log(m.agents['pipeline-evaluator'].requires.length)")
assert_eq "$PE_REQ" "0" "pipeline-evaluator has no hard requirements"

# ── 4. Config schema accepts pipelineEvaluation block ─────────────────────────
# The config.json we wrote above should be parseable without error by any
# schema-aware consumer; verify it is valid JSON and has the expected fields.
CADENCE=$(node -e "const c=require('$WORK/.pipeline/config.json'); console.log(c.pipelineEvaluation.cadence)")
assert_eq "$CADENCE" "50" "config pipelineEvaluation.cadence=50 round-trips correctly"
ENABLED=$(node -e "const c=require('$WORK/.pipeline/config.json'); console.log(c.pipelineEvaluation.enabled)")
assert_eq "$ENABLED" "true" "config pipelineEvaluation.enabled round-trips correctly"

# ── 5. Artifact shapes validate with jq ───────────────────────────────────────
mkdir -p "$WORK/.pipeline/improvement"

# cursor.json shape
cat > "$WORK/.pipeline/improvement/cursor.json" <<'JSON'
{ "runId": "run-abc123", "lessonCount": 12, "improverMergeSha": "deadbeef", "evaluatedAt": "2026-06-16T00:00:00Z" }
JSON
CURSOR_RID=$(node -e "console.log(require('$WORK/.pipeline/improvement/cursor.json').runId)")
assert_eq "$CURSOR_RID" "run-abc123" "cursor.json runId round-trips"

# scorecard.jsonl entry shape
cat > "$WORK/.pipeline/improvement/scorecard.jsonl" <<'JSON'
{ "evaluatedAt": "2026-06-16T00:00:00Z", "window": { "fromRunId": null, "toRunId": "run-abc123", "runCount": 1 }, "metrics": { "humanInterventionRate": 0.1, "reworkRate": 0.05, "cycleYield": 0.8, "costPerShippedTicket": 0.3, "findingsPerAgent": {} }, "provenance": "agent:pipeline-evaluator" }
JSON
SCORE_PROV=$(node -e "const lines=require('fs').readFileSync('$WORK/.pipeline/improvement/scorecard.jsonl','utf8').trim().split('\n'); console.log(JSON.parse(lines[0]).provenance)")
assert_eq "$SCORE_PROV" "agent:pipeline-evaluator" "scorecard.jsonl provenance field correct"

# ledger.jsonl entry shape
cat > "$WORK/.pipeline/improvement/ledger.jsonl" <<'JSON'
{ "changedAt": "2026-06-16T00:00:00Z", "changeType": "new-agent", "target": "test-monitor", "finding": "cg-001", "evidence": ["run-abc123"], "prRef": "chore/agent-architect/test-monitor", "summary": "Added test-monitor to own repeated test-runner crashes.", "provenance": "agent:agent-architect" }
JSON
LEDGER_TYPE=$(node -e "const lines=require('fs').readFileSync('$WORK/.pipeline/improvement/ledger.jsonl','utf8').trim().split('\n'); console.log(JSON.parse(lines[0]).changeType)")
assert_eq "$LEDGER_TYPE" "new-agent" "ledger.jsonl changeType field correct"
LEDGER_PROV=$(node -e "const lines=require('fs').readFileSync('$WORK/.pipeline/improvement/ledger.jsonl','utf8').trim().split('\n'); console.log(JSON.parse(lines[0]).provenance)")
assert_eq "$LEDGER_PROV" "agent:agent-architect" "ledger.jsonl provenance field correct"

# ── 6. agent-improver consumes improvement-regression ─────────────────────────
CONSUMES=$(grep "consumes:" "$REPO_ROOT/agents/agent-improver.md")
assert_contains "$CONSUMES" "improvement-regression" "agent-improver consumes improvement-regression"

echo
echo "13-macro-self-improvement: all assertions passed"
```

- [ ] **Step 3: Make the test executable and run it**

```bash
chmod +x /Users/ryan/Code/cap-meta-self-improvement/test/e2e/13-macro-self-improvement.sh
bash /Users/ryan/Code/cap-meta-self-improvement/test/e2e/13-macro-self-improvement.sh
```
Expected: ends with `13-macro-self-improvement: all assertions passed`

- [ ] **Step 4: Run the full e2e suite to confirm no regressions**

```bash
cd /Users/ryan/Code/cap-meta-self-improvement
bash test/e2e/run-all.sh 2>&1 | tail -20
```
Expected: all tests pass, including the new `13-macro-self-improvement`.

- [ ] **Step 5: Commit**

```bash
/usr/bin/git -C /Users/ryan/Code/cap-meta-self-improvement add test/e2e/13-macro-self-improvement.sh
/usr/bin/git -C /Users/ryan/Code/cap-meta-self-improvement commit -m "test: e2e parse + manifest + artifact-shape tests for macro self-improvement pair"
```

---

## Self-Review

Checked the spec against each task:

| Spec requirement | Task |
|---|---|
| `pipelineEvaluation` config block (enabled, cadence, minNewLessons, minImproverMerges) | Task 1 |
| `pipeline-evaluator` agent def (both metadata halves, three jobs, scorecard, cursor, finding formats) | Task 2 |
| `manifest.json` entry for `pipeline-evaluator` (stage=improvement, requires=[], optional=[github,linear]) | Task 2 |
| `agent-architect` agent def (three change types, ledger, digest, loop-critical guardrail, retiring def) | Task 3 |
| `manifest.json` entry for `agent-architect` (stage=implementation, requires=[github]) | Task 3 |
| `agent-improver` consumes extension + Identify update | Task 4 |
| Orchestrator dispatch row (volume-triggered, cursor-aware) + finding-type routing | Task 5 |
| `ORCHESTRATION.md` five-layer note + role-overlap table | Task 5 |
| `PIPELINE.md` dispatch cadence rows + provenance labels | Task 5 |
| `README.md` Improvement stage description | Task 5 |
| E2E: agent parse, manifest entries, artifact shapes, agent-improver consumes | Task 6 |
| `.pipeline/improvement/` dir (cursor.json, scorecard.jsonl, ledger.jsonl shapes) | Tasks 2, 3, 6 |
| Both agents off by default | Task 1 (default false) + Tasks 2–3 (idle on disabled) |
| Loop-critical file guardrail (orchestrator.md, agent-work-protocol.md, self-referential) | Task 3 |

No gaps found.
