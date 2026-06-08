# E2E Tests

End-to-end integration tests that dispatch real agents and assert the CLI's observability surface matches what those agents actually do in the filesystem.

## Run

```bash
# Free smoke test only (no claude invocation, ~5s)
npm run test:e2e:smoke

# Everything — smoke + skips live tests
npm run test:e2e

# Everything including live claude tests (costs OAuth quota, ~$3 total)
CAP_E2E_LIVE=1 npm run test:e2e

# A single test
bash test/e2e/01-lifecycle-smoke.sh
CAP_E2E_LIVE=1 bash test/e2e/02-pipeline-scanner.sh
```

## Test inventory

| File | Cost | Time | What it verifies |
|------|------|------|------------------|
| `01-lifecycle-smoke.sh` | $0 | ~5s | CLI runs surface end-to-end (list, query, kill, events, pipe-safety) using a stubbed supervisor. No claude calls. |
| `02-pipeline-scanner.sh` | ~$0.30 | ~30s | Real scanner against the seeded fixture. Verifies dispatch → active → completed transition + event log shape. Requires `CAP_E2E_LIVE=1`. |
| `03-pipeline-full.sh` | ~$2–3 | ~5min | Multi-stage: scan → ticket-reviewer → worker → tester. Asserts ticket-state-machine transitions visible to the CLI after each agent. Requires `CAP_E2E_LIVE=1`. |

## Layout

```
test/
  fixtures/
    full-pipeline/           # minimal TS project intentionally seeded
      src/                   # scanner-detectable issues (silent catch, dead code, TODO)
      .pipeline/config.json  # filesystem backend (no Linear)
      docs/glossary.md
  e2e/
    lib/
      setup.sh               # copies fixture to tmp, installs agents, traps cleanup
      assertions.sh          # assert_eq, assert_run_status, etc.
      fake-run.sh            # stubbed supervisor for smoke test
    01-lifecycle-smoke.sh    # free
    02-pipeline-scanner.sh   # live
    03-pipeline-full.sh      # live
    run-all.sh
```

## Cost gate

The `02-` and `03-` tests are gated behind `CAP_E2E_LIVE=1` to prevent accidental spend. Without it they print `SKIP:` and exit 0. The runner counts these as `skipped` (not passed, not failed).

## Why so opt-in?

Each live agent invocation costs $0.10–0.50 of OAuth quota and takes 10s–2min. Running the full suite on every commit would burn $10+/day. Treat live tests as pre-release validation, not CI gate.

If you want deterministic, free CI, the smoke test alone covers the dispatch/observability layer the package actually owns — anything below that is agent-behavior territory, which is best validated manually.

## Why a separate fixture and not just an ad-hoc tmp dir?

Reproducibility: every live test starts from the same intentional seed. The fixture's `README.md` documents what each file is meant to trigger, so when an assertion fails you can tell whether the agent missed something it should have found, or whether the assertion expects something the agent legitimately wouldn't.

## Adding a new test

1. Put fixture files under `test/fixtures/<scenario>/`. The setup helper copies the whole dir to tmp; agents see it as their project root.
2. Create `test/e2e/0N-<name>.sh`:
   ```bash
   #!/usr/bin/env bash
   set -uo pipefail
   if [ "${CAP_E2E_LIVE:-0}" != "1" ]; then echo "SKIP: ..."; exit 0; fi
   HERE="$(cd "$(dirname "$0")" && pwd)"
   FIXTURE=<scenario> . "$HERE/lib/setup.sh"
   . "$HERE/lib/assertions.sh"
   # ... dispatch + assert ...
   ```
3. Use `ap` (defined in `lib/assertions.sh`) instead of raw `agent-pipeline` calls — it injects `--target` automatically.

## Known limitations

- **Tests don't pass on first author.** The live tests are forcing functions; assertions about agent side-effects assume specific contracts (e.g., scanner writing ticket JSONs to `needs-triage/`). Real agent prompts may or may not honor that without further wiring. When a test fails, the question to ask is: *do we want the agent to behave this way, or do we want the test to expect what the agent actually does?* Usually it's a mix.
- **Model nondeterminism.** Same prompt can produce different outputs. Tests assert on *shape* (counts, file existence, status fields) not content.
- **macOS-only verified.** `--detach` supervisor pattern and `mktemp -d -t` flags are POSIX-ish but untested on Windows.
