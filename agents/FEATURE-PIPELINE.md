# Feature Pipeline

An epic-level state machine layered above the ticket pipeline. A feature (epic) moves autonomously through spec, design, decomposition, child execution, integration, and acceptance — then stops at a single human gate before merging to `main`. Each stage is owned by a dedicated feature agent; the orchestrator monitors the `building` stage, gates child dependencies, and auto-merges passing children into the integration branch.

## Feature States

Each state is represented by a GitHub issue label, a Linear label, or a queue subdirectory (filesystem backend). A feature agent picks up epics in its input state and transitions them to its output state.

The label namespace for feature epics is `feature`.

| State Label | Meaning | Owned By |
|---|---|---|
| `feature:needs-spec` | Rough intent captured; needs elaboration into a spec | feature-spec-writer |
| `feature:needs-design` | Spec ready; needs a technical design + integration branch | feature-architect |
| `feature:needs-decomposition` | Design ready; needs breakdown into child tickets | feature-decomposer |
| `feature:building` | Children created and flowing through the ticket pipeline; orchestrator monitors + auto-merges them | (orchestrator) |
| `feature:needs-integration` | All children merged into the integration branch; needs reconcile + epic PR | feature-integrator |
| `feature:needs-acceptance` | Epic PR open; needs feature-level acceptance validation | feature-acceptance-validator |
| `feature:ready-for-human` | Assembled feature passes all checks; single human review | (terminal) |
| `feature:blocked` | A child or stage is stuck and needs a human | (human) |
| `feature:needs-feedback` | Human left comments on the epic PR; route back to the relevant stage | (orchestrator) |
| `feature:done` | Integration branch merged to main | (cleanup) |

## Integration Branch

The feature-architect creates a branch named `feature/<EPIC-id>` off `main` at design time. Every child ticket produced by the decomposer sets its `base` to that branch rather than `main`. Passing children auto-merge into the integration branch (no per-child human gate — see Child auto-merge below). When all children are `done`, the integrator opens the epic PR from `feature/<EPIC-id>` → `main`.

## Dependency Gating

The decomposer places each child ticket into one of two queues based on whether it has unresolved prerequisites:

- **Dependency-free** children go directly into `.pipeline/queue/needs-work/` and start flowing through the ticket pipeline immediately.
- **Dependency-blocked** children go into `.pipeline/queue/needs-info/` and carry `epic`, `depends_on` (a list of child ids), and `base` fields in their JSON.

Each orchestrator cycle, for every parked child in `needs-info/`, the orchestrator checks whether every id in the child's `depends_on` list is in the `done` state. When all dependencies are `done`, the orchestrator promotes the child:

```bash
queue/queue-claim.sh <child-id> needs-info needs-work --queue-dir .pipeline/queue
```

This ensures children execute in the correct order without the decomposer having to sequence them explicitly.

## Child Auto-Merge

When a child ticket whose JSON contains an `epic` field reaches `pipeline:ready-for-human`, the orchestrator merges it into the integration branch instead of leaving it for the human reviewer. Procedure (filesystem backend):

```bash
EPIC_BRANCH=$(jq -r .integration_branch .pipeline/epics/building/<EPIC-id>.json)
git fetch origin
git checkout "$EPIC_BRANCH"
git merge --no-ff "<child-branch>" -m "merge <child-id> into $EPIC_BRANCH"
git push origin "$EPIC_BRANCH"
queue/queue-claim.sh <child-id> ready-for-human done --queue-dir .pipeline/queue
```

On a merge conflict, the orchestrator routes the child to `needs-conflict-resolution`; the existing conflict-resolver handles it against the child's `base` (the integration branch). When **every** child id in the epic's `children` list is in `done`, the orchestrator advances the epic:

```bash
queue/queue-claim.sh <EPIC-id> building needs-integration --queue-dir .pipeline/epics
```

## Dispatch Triggers

Feature agents are dispatched by the orchestrator on the same cycle as ticket-pipeline agents.

| Agent | Dispatched when |
|---|---|
| feature-spec-writer | `feature:needs-spec` epics exist |
| feature-architect | `feature:needs-design` epics exist |
| feature-decomposer | `feature:needs-decomposition` epics exist |
| feature-integrator | `feature:needs-integration` epics exist |
| feature-acceptance-validator | `feature:needs-acceptance` epics exist |
| (orchestrator rules) | `feature:building` epics exist → gate deps, auto-merge passing children, advance when all `done` |
| feedback-responder | `feature:needs-feedback` epics exist → address comments and push |

## Feedback Loop

When an epic is in `feature:needs-feedback` (from a failed acceptance check or human comments on the epic PR), the orchestrator dispatches `feedback-responder` against the epic PR to address the feedback. After the responder pushes its changes, the orchestrator returns the epic to `feature:needs-acceptance` for re-validation:

```bash
queue/queue-claim.sh <EPIC-id> needs-feedback needs-acceptance --queue-dir .pipeline/epics
```

A human merging the epic PR moves it to `feature:done`. Post-merge cleanup (e.g., deleting the integration branch) is handled the same way as in the ticket pipeline.

## Backends

### Filesystem backend

When `config.backend = "filesystem"`:

- Epics live as JSON files: `.pipeline/epics/<state>/<EPIC-id>.json`
- State transitions use the same helper scripts as the ticket pipeline, with `--queue-dir .pipeline/epics` instead of `--queue-dir .pipeline/queue`
- Each epic JSON includes at minimum: `id`, `title`, `integration_branch`, `children` (list of child ids), and `state`
- Child tickets use the standard `.pipeline/queue/<state>/` paths and carry `epic` + `base` fields

### Linear backend

When `config.backend = "linear"`:

- An epic maps to a Linear project (or a parent issue with sub-issues)
- Feature states are applied as `feature:*` labels on the project or parent issue
- Child issues carry both the standard `pipeline:*` labels and a reference to their parent epic

### GitHub backend

When `config.backend = "github"`:

- An epic is a GitHub tracking issue with `feature:*` labels
- Child tickets are PRs labeled with the epic's id (e.g., `epic:<EPIC-id>`)
- State transitions update the tracking issue's labels; child PR merges are recorded in the tracking issue's body
