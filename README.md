# claude-agent-pipeline

A self-orchestrating multi-agent development pipeline for [Claude Code](https://claude.com/claude-code). One orchestrator loop watches a backlog, dispatches specialist agents on demand, and routes work through scan → ticket → implement → review → human-merge with labeled handoffs at every stage.

Stack-agnostic core. Ships an opinionated TypeScript/React rule preset. Dependency-aware install: agents that need Linear, Playwright, or `gh` are filtered to what your environment supports.

## What it does

```
Scanner → Ticket Creator → Ticket Reviewer → Worker → Tester → Code Reviewer → Feedback Responder
                                                                                       ↓
                                                                               ready-for-human
                                                                                       ↓
                                                                                Human merges
                                                                                       ↓
                                                                                  Cleanup
```

Each agent watches for one specific state (a label or a directory) and hands off to the next stage by transitioning that state. The orchestrator is the only persistent loop — every other agent is dispatched on demand when its input queue is non-empty.

See [`agents/ORCHESTRATION.md`](./agents/ORCHESTRATION.md) for the full state-machine diagram.

## Install

### Via npm (recommended)

```bash
# One-off, into a target project
npx claude-agent-pipeline install ~/Code/my-app

# Or install the CLI globally
npm install -g claude-agent-pipeline
agent-pipeline install ~/Code/my-app

# Or as a devDependency in the target project
npm install --save-dev claude-agent-pipeline
npx agent-pipeline install .
```

The installer symlinks the package's `agents/`, `rules/`, and `commands/` into `<target>/.claude/`. Symlink mode (default) means `npm update claude-agent-pipeline` propagates to every project that installed it. Use `--mode copy` for a detached install.

### Local clone (for development)

```bash
git clone https://github.com/RyanAmundson/claude-agent-pipeline.git
cd claude-agent-pipeline
node bin/cli.js install ~/Code/my-app
# or the equivalent shell version:
./scripts/install-local.sh ~/Code/my-app
```

## CLI

```
agent-pipeline install <target> [options]      Install agents/rules/commands into a project
agent-pipeline list-agents [--target <p>]      List agents and dep status
agent-pipeline list-presets                    List rule presets
agent-pipeline detect [--target <p>]           Detect available deps in target environment
agent-pipeline version                         Print version

# Dispatch & observability — see docs/API.md for full reference
agent-pipeline run <agent> --prompt "..." [--target <p>] [--wait|--detach|--follow] [--json]
agent-pipeline runs [--target <p>] [--json]                   List active + recent runs
agent-pipeline runs <runId> [--target <p>] [--follow] [--json]   Inspect / tail a run
agent-pipeline runs <runId> events [--target <p>] [--json]    Dump captured event log
agent-pipeline runs kill <runId> [--target <p>]               Terminate a running supervisor
agent-pipeline events [--target <p>] [--json]                 Live pipeline event stream (JSONL)
agent-pipeline ui [--target <p>] [--port N] [--open]          Launch dashboard + HTTP/SSE API
```

### Install flags

| Flag | Meaning |
|------|---------|
| `--mode symlink\|copy` | Symlink (default, live updates) or copy (detached) |
| `--preset <name>` | Rule preset (default: `minimal`). See `list-presets`. |
| `--all` | Install every agent regardless of dep detection |
| `--with <dep>` | Force-enable a dep (repeatable) — `github`, `linear`, `playwright`, `agent-browser`, `chrome-devtools` |
| `--without <dep>` | Force-disable a dep (repeatable) |
| `--omit-agent <name>` | Skip a specific agent (repeatable) |
| `--omit-rule <file>` | Skip a specific rule file (repeatable) |
| `--dry-run` | Print what would be installed; make no changes |
| `--quiet` | Suppress per-file output |

The installer never overwrites a non-symlink file in the target — pre-existing custom agents/rules are preserved.

## Dependency-aware install

Each agent declares the external systems it needs. The CLI detects what's available in the target environment and only installs agents whose deps are met (override with `--all`).

| Dep | Detection | Used by |
|-----|-----------|---------|
| `github` | `gh` on PATH | Most agents that read PRs / post comments |
| `linear` | manual (use `--with linear`) | `linear-issue-orchestrator`, `ticket-creator` (Linear backend) |
| `playwright` | target's `package.json` includes `@playwright/test` | `e2e-test-runner`, `e2e-test-quality` |
| `agent-browser` | `agent-browser` on PATH | a11y/perf detectors (runtime audits) |
| `chrome-devtools` | manual | a11y/perf detectors (runtime audits) |

Run `agent-pipeline detect --target ~/Code/my-app` to see the report without installing.

## Dispatch & observability

The pipeline can be driven entirely from the orchestrator agent (the original use case), but every agent is also independently dispatchable from a host tool — CLI, Node, or HTTP.

```bash
# Dispatch an agent, get back a runId immediately
RES=$(agent-pipeline run scanner \
  --prompt "Scan src/ for silent error handlers" \
  --target ~/Code/my-app \
  --max-budget-usd 0.30 \
  --detach --json)
RUN_ID=$(echo "$RES" | jq -r .runId)

# Watch it
agent-pipeline runs "$RUN_ID" --follow --target ~/Code/my-app

# Kill it
agent-pipeline runs kill "$RUN_ID" --target ~/Code/my-app
```

State lives at `<target>/.pipeline/runs/{active,completed,logs}/`. Multiple consumers (CLI tail, dashboard, host-app subscribers) can observe the same project concurrently.

**Three subscription surfaces:**

```js
// 1. Node (in-process, push-based)
import { createWatcher } from 'claude-agent-pipeline/api';
const w = createWatcher({ target });
w.on('run.complete', ev => console.log(ev.run.runId, ev.run.cost));
```

```bash
# 2. CLI (JSONL on stdout, language-agnostic)
agent-pipeline events --target ~/Code/my-app --json | jq .
```

```js
// 3. HTTP / SSE (remote / browser)
const es = new EventSource('http://127.0.0.1:7733/api/v1/events');
es.onmessage = ({ data }) => handle(JSON.parse(data));
```

Full reference: [`docs/API.md`](./docs/API.md). Types: [`api/index.d.ts`](./api/index.d.ts).

A self-contained demo script that exercises the full dispatch / query / follow / kill loop lives at [`scripts/demo-run-loop.sh`](./scripts/demo-run-loop.sh).

## First-run setup

After install, in Claude Code from the target project:

```
/pipeline init
```

This writes `.pipeline/config.json` (repo, GitHub user, backend, label allowlists). Then:

```
/pipeline start
```

starts the orchestrator on a self-paced loop.

## Configuration

Per-project config lives at `.pipeline/config.json`. See [`config.schema.json`](./config.schema.json) for the full shape. Minimum:

```json
{
  "repo": "owner/repo",
  "ghUser": "your-github-handle",
  "backend": "linear",
  "linear": { "teamId": "ENG" }
}
```

For projects that route to per-feature specialists, optionally add `.pipeline/routing.json` (used by `linear-issue-orchestrator`).

## Backends

### Linear (recommended)

Uses your Linear MCP integration. Tickets live in Linear; the pipeline reads/writes them via `mcp__linear__*` tools.

### Filesystem (offline fallback)

Tickets live as JSON files under `.pipeline/queue/<state>/<id>.json`. State transitions are filesystem moves — `mv` is atomic within a filesystem, so first agent wins and second gets ENOENT. No locking needed.

```
.pipeline/queue/
  needs-work/
  in-progress/
  needs-test-review/
  ready-for-human/
  done/
```

## Agents

31 agents across these stages (see [`manifest.json`](./manifest.json) for the canonical list and dep tags):

| Stage | Agents |
|-------|--------|
| **Intake** | scanner, ticket-creator |
| **Routing** | ticket-reviewer, flex-worker, linear-issue-orchestrator |
| **Implementation** | worker, declarative-refactor-specialist, folder-structure-enforcer, technical-docs-manager, branch-updater, agent-improver |
| **Quality** | tester, e2e-test-quality, e2e-test-runner, ci-triage, data-validator |
| **Review** | code-reviewer, feedback-responder, cleanup |
| **Detectors** (round-robin) | a11y, perf, security, pipeline-violation, mock-contract, density-system, justification |
| **Improvement** | transcript-reviewer (reviews run/session transcripts → lessons + agent-def fixes via agent-improver) |
| **Utilities** | glossary-maintainer, context-mapper, git-worktree-manager |
| **Meta** | orchestrator |

Project-specific implementation specialists (e.g., `auth-specialist`, `billing-specialist`) are expected to live in your host project's `.claude/agents/`. The pipeline routes to them via `.pipeline/routing.json`.

## Rules

Rules live in [`rules/`](./rules/) and are installed via the chosen `--preset`:

### `minimal` (default)

Stack-agnostic foundational rules:

- `agent-work-protocol.md` — the contract every dispatchable agent follows
- `justify-non-standard-additions.md` — requires written justification for parallel systems / duplicates / disabled guardrails

### `typescript-react`

Adds 10 stack-specific rules: `data-pipeline`, `react-query`, `view-models`, `canonical-and-composed-hooks`, `naming-conventions`, `collection-folders`, `component-hierarchy`, `mock-data-density`, `e2e-testing`, `playwright-mcp`. See [`rules/presets/typescript-react/README.md`](./rules/presets/typescript-react/README.md).

### `templates`

Empty starter rule files in [`rules/templates/`](./rules/templates/) for projects that want to author their own conventions from scratch.

You can also `--omit-rule react-query.md` to skip individual rules within a preset.

## Customizing

Most agents read scope details from `.pipeline/config.json` rather than hardcoded values. To add your own agents alongside the pipeline, drop them into your host project's `.claude/agents/` — they coexist with the symlinked package agents. Custom agents take precedence over package agents with the same name.

## Development

This repo is both:

1. A **Claude Code plugin** (`plugin.json` at root, `agents/`, `commands/`, `skills/`, `rules/`)
2. An **npm package** (`package.json`, `bin/cli.js`)

The CLI is a single Node file with no runtime deps. Smoke-test via:

```bash
npm test                  # CLI smoke test (no model spend)
npm run test:e2e:smoke    # E2E: lifecycle / kill / events surface (no model spend)
npm run test:e2e          # E2E: smoke + skipped live tests
CAP_E2E_LIVE=1 npm run test:e2e  # E2E: includes real-claude pipeline tests (~$3)
npm run pack:dry          # show what would ship to npm
```

The E2E suite lives in `test/e2e/` with a seeded fixture under `test/fixtures/full-pipeline/`. See [`test/e2e/README.md`](./test/e2e/README.md) for what each test covers and how to add new scenarios.

## License

MIT — see [`LICENSE`](./LICENSE).
