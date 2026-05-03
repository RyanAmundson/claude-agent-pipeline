# Queue Helpers (filesystem backend)

Shell scripts that implement the filesystem-backed ticket queue. Used when `config.backend = "filesystem"`.

## Concept

Tickets are JSON files. State is encoded by which subdirectory the file lives in:

```
.pipeline/queue/
├── needs-triage/     # scanner findings awaiting ticket creation
├── needs-review/     # tickets awaiting validation
├── needs-work/       # tickets ready to implement
├── in-progress/      # claimed by a worker
├── needs-test-review/  # PR open, awaiting tester
├── needs-code-review/  # tester passed, awaiting code review
├── needs-feedback/   # review feedback to address
├── ready-for-human/  # all automated checks passed
├── done/             # merged and cleaned up
└── needs-info/       # parked, missing detail
```

State transitions are filesystem moves. `mv` within the same filesystem is atomic — exactly one caller wins.

## Ticket file shape

```json
{
  "id": "TKT-001",
  "title": "fix: silent error in dashboard fetch",
  "description": "...",
  "priority": 2,
  "labels": ["smell", "agent:scanner"],
  "source": {
    "agent": "scanner",
    "category": "silent-error",
    "file": "src/dashboard/Dashboard.tsx",
    "line": 88
  },
  "pr_url": null,
  "stale_count": 0,
  "created_at": "2026-04-30T10:00:00Z",
  "updated_at": "2026-04-30T10:00:00Z"
}
```

The `id` field is the canonical identifier — also the file's basename (`<id>.json`).

## Helpers

### `queue-list.sh <state>`

List tickets in a state. Output is `<id>\t<priority>\t<title>`, sorted by priority then by oldest mtime.

```bash
queue-list.sh needs-work
queue-list.sh in-progress --queue-dir .pipeline/queue
```

### `queue-claim.sh <id> <from-state> <to-state>`

Atomic claim. Moves the JSON file from one state to another. Exits 0 on success, 1 on race (file already moved by another agent).

```bash
queue-claim.sh TKT-001 needs-work in-progress
```

This is the only safe way to claim — workers MUST use this, not direct `mv`.

### `queue-update.sh <state> <id> <jq-expression>`

Read-modify-write a ticket field, serialized via `flock`. Use for setting `pr_url`, updating `description`, etc.

```bash
queue-update.sh in-progress TKT-001 '.pr_url = "https://github.com/o/r/pull/42"'
```

### `queue-stale.sh [--max-age-hours N]`

Find stale tickets in `in-progress/` and move them back. Default age threshold is 2 hours.

```bash
queue-stale.sh
queue-stale.sh --max-age-hours 4 --dry-run
```

The cleanup agent runs this periodically.

## Concurrency model

| Operation | Mechanism | Safety |
|---|---|---|
| Claim a ticket | `mv` between state dirs | Atomic. First caller wins, others get ENOENT |
| Update a field | `flock` + `jq` + `mv` | Serialized. Last writer wins |
| Transition states | `mv` | Atomic |
| List a state | `find` | No locking; results may be slightly stale, that's fine |

This works on a single filesystem. It does NOT work across hosts (NFS atomicity is unreliable). If you need multi-host, switch to the Linear backend.
