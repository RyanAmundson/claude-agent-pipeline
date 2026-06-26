# Plan: `import-sources` projector (beads + plans → filesystem queue)

- **Bead:** cm-rofv (CAP side of cm-crwm)
- **Date:** 2026-06-26
- **Spec:** context-manager `docs/superpowers/specs/2026-06-25-pipeline-source-intake-design.md`
- **Branch:** `feat/import-sources-projector` (off `main`)

## Goal

Make the pipeline draw work from the project's real sources without a new
`backend` enum. A new zero-dep Node command projects **bd-ready beads** and
**incomplete plans** into the filesystem queue as `needs-work` tickets, idempotently,
each cycle. One-way (never writes back). The existing orchestrator then routes them.

## Architecture (grounded in the CAP codebase)

- Tickets are JSON at `.pipeline/queue/<state>/<id>.json`; the state subdir is the
  routing (`api/index.js`, `queue/README.md`). New work lands in `needs-work/`.
- Ticket shape (`queue/README.md`): `{ id, title, description?, priority, labels[],
  source{}, created_at, updated_at }`. `id` is the file basename.
- Write pattern mirrors `runFeature` in `bin/cli.js`: build object → `mkdirSync(dir,
  {recursive:true})` → `writeFileSync(<id>.json, JSON.stringify(obj,null,2))`.
- `targetOf(flags)` (default cwd) + `resolveQueueDir(target)` (reads
  `.pipeline/config.json` `filesystem.queueDir`, default `.pipeline/queue`) already exist.
- `STATES` (the 15 queue states) is exported from `api/index.js` — use it to scan
  every state for idempotency.
- Tests: `node:test` + `node:assert/strict`, temp dirs via `mkdtempSync`, CLI run via
  `execFileSync('node', [CLI, ...])` (see `test/unit/feature-cli.test.js`).

## Mapping

| Source | → Ticket id | Fields |
|--------|-------------|--------|
| each `bd ready` bead | `bead:<beadId>` | title, description, priority (0–4 verbatim), `labels:["source:beads"]`, `source:{type:"beads",beadId,issueType}` |
| each **incomplete** plan `*.md` | `plan:<slug>` (one ticket, whole plan) | title (first `# ` heading or filename), priority (default 2), `labels:["source:plans"]`, `source:{type:"plans",path}` |

- **Plan completeness:** a plan is *complete* iff it contains ≥1 task checkbox and
  **all** are checked (`- [x]`); a plan with no checkboxes is treated as incomplete
  (actionable). Complete plans are skipped. (Mirrors CM `parsePlanMeta`'s
  `completedTasks === totalTasks && totalTasks > 0`.)

### ID & filesystem-safety (cross-repo contract — VERIFIED against the shipped CM side)

CM joins a work item to its pipeline ticket on `ticketId === ${entityType}:${entityId}`
(`usePipelineTicketForEntity`), and CM's `PipelineRxWriter` sets `ticketId` from the
ticket's **JSON `id` field** (not the filename). For a plan, CM's `entityId` is the
plan **`relativePath`** = `${dirRel}/${filename}` (e.g. `docs/superpowers/plans/foo.md`),
stamped by CM's scanner (`electron/ipc/plans.ts`). Therefore:

- Ticket **JSON `id`** = `bead:<beadId>` / `plan:<relativePath>` — **verbatim**, so the
  CM StageTimeline lights up. No slugification (a slug would break the join). No CM change.
- Ticket **file basename** = `safeBasename(id)` = `id.replace(/[\/:]+/g, '_')` — flat,
  portable (relativePath `/` would otherwise break the filename). So
  `plan:docs/superpowers/plans/foo.md` → file `plan_docs_superpowers_plans_foo.md.json`,
  JSON `id` stays `plan:docs/superpowers/plans/foo.md`. `bead:cm-x` → `bead_cm-x.json`.
- **Idempotency is keyed on the basename** across all states (CAP's queue machinery is
  filename-keyed; `getTicket`-by-id for these is a non-critical casualty of id≠basename).
- The CAP projector must compute `relativePath` the SAME way CM does — repo-relative
  `${dirRel}/${filename}` — so configure `sources.plans` with the same repo-relative
  dirs CM scans (`.plans`, `.claude`, custom `planFolders`), resolved against `target`.

## Idempotency

Before creating `<id>.json`, scan **every** state dir under the queue for an existing
`<id>.json`. Create only if absent everywhere — so an item already `in-progress` /
`done` / etc. is never resurrected or duplicated.

## Config

Extend `.pipeline/config.json` with an optional `sources` block:
`{ "sources": { "beads": true, "plans": [".context-manager/plans", "~/.claude/plans"] } }`.
**Opt-in:** when `sources` is absent the command is a no-op and prints a hint (never a
new `backend` value). `beads:true` enables the `bd ready` read; `plans` is the list of
dirs to scan (`~` expanded).

---

## Task 1 — Core projector module + unit tests

**File:** `runner/import-sources.js` (new) — `test/unit/import-sources.test.js` (new).

Export pure-ish, dependency-injected core:

```js
export function importSources({
  target, queueDir = resolveQueueDir(target), sources,
  only = null, readBeads = defaultReadBeads, scanPlans = defaultScanPlans,
  now = () => new Date().toISOString(),
}) // → { created: string[], skipped: string[] }
```

- `existingTicketIds(queueDir)` — scan all `STATES` subdirs, return `Set<id>` of basenames.
- Build candidate tickets from `sources.beads ? readBeads(target) : []` and
  `scanPlans(sources.plans ?? [])` (filtered to incomplete).
- If `only` is set, keep only the candidate whose id === `only`.
- Skip a candidate whose id is in `existingTicketIds`; else write to `needs-work/`.
- Return created/skipped id lists.

Default readers (also exported for the CLI):
- `defaultReadBeads(target)` — `execFileSync('bd', ['ready','--json'], {cwd:target})`,
  JSON.parse; on ENOENT/non-zero, `console.warn` and return `[]` (surface, don't swallow).
- `defaultScanPlans(dirs)` — expand `~`, read `*.md` recursively, return
  `{ path, slug, title, complete }`.

Pure helpers (unit-tested directly): `planSlug(relPath)`, `planIsComplete(md)`,
`beadToTicket(bead, now)`, `planToTicket(plan, now)`.

**RED→GREEN tests:**
1. beads → `needs-work/bead:<id>.json` with priority/labels/source (inject `readBeads`).
2. incomplete plan → one `plan:<slug>` ticket; complete plan skipped (inject `scanPlans`).
3. idempotency: seed `in-progress/bead:x.json`; `bead:x` candidate is skipped, returned in `skipped`.
4. `only: 'bead:x'` projects only that id even when others are ready.
5. `planSlug` is filesystem-safe + stable; `planIsComplete` truth table.

## Task 2 — CLI command `import-sources`

**File:** `bin/cli.js` (edit) — `test/unit/import-sources-cli.test.js` (new).

- Add `--only` to `parseFlags` (`case '--only': flags.only = args[++i]`).
- Add `case 'import-sources': runImportSources(flags); break;` + a HELP entry.
- `runImportSources(flags)`: `target=targetOf(flags)`, read `.pipeline/config.json`
  `sources`; if absent → print opt-in hint, exit 0. Else call `importSources(...)`,
  then print `import-sources: created N, skipped M` (or `--json` the result).
- **CLI test (no `bd` needed):** temp target + config `{sources:{plans:["plans"]}}` +
  `plans/foo.md` (incomplete) → run CLI → assert `needs-work/plan:foo.json` exists and
  stdout reports `created 1`; a second run reports `created 0, skipped 1` (idempotent).

## Task 3 — Pre-cycle wiring in the supervisor

**File:** `runner/orchestrator-supervisor.js` (edit) — extend
`test/unit/orchestrator-supervisor.test.js`.

- Inject `importSources` into `supervisorIteration({...})` and
  `runOrchestratorSupervisor({...})`, default = a best-effort wrapper that calls the
  real projector and `try/catch`es (warn, **never throw** — a sync failure must not
  break the cycle).
- Call it immediately **before** `await dispatchCycle(target)`.
- **Tests:** (a) on a due tick, `importSources` is called before `dispatchCycle`
  (order via shared spy log); (b) a throwing `importSources` still lets `dispatchCycle`
  run (best-effort).

## Task 4 — Config schema + help/docs

**Files:** `config.schema.json` (edit), `queue/README.md` or `docs/` note (edit).

- Add optional `sources` object to `config.schema.json` properties:
  `{ beads?: boolean, plans?: string[] (default []) }`, `additionalProperties:false`.
- Document the projector briefly (one section): what it does, the mapping, opt-in config.

## Non-goals (this plan)

- Write-back (closing beads / checking plan tasks) — one-way v1.
- Retracting items that leave `bd ready` after pickup.
- The CM-side launch-mode toggle + enqueue IPC (cm-mxwf, separate).

## Gates

`npm run test:unit` (node:test) green; new tests cover mapping, idempotency, `--only`,
CLI plan projection, and pre-cycle ordering. Final whole-branch review before merge.
