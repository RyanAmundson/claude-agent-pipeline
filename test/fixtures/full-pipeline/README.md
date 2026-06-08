# Full-Pipeline E2E Fixture

Minimal TypeScript project intentionally seeded with patterns the scanner agent should flag:

| File | Pattern | Expected scanner finding |
|------|---------|--------------------------|
| `src/api.ts` | Silent catch (`console.error` only) | "silent error handling" |
| `src/utils.ts` | `TODO`/`FIXME` without ticket ref, `any` cast | "untracked TODO", "any cast without justification" |
| `src/dead-helper.ts` | Module never imported | "dead code / orphan module" |

`src/index.ts` imports `api` and `utils` but not `dead-helper`, so the dead-code detector has unambiguous evidence.

## Config

- **Backend:** `filesystem` (no Linear / no external state) — see `.pipeline/config.json`
- **Verify commands:** stubbed `npm run type-check` / `npm run lint` that always succeed, so worker/tester don't fail on real TS errors

## How it's used

The fixture is **copied** to a tmp dir by `test/e2e/lib/setup.sh` before each test run, then agents are installed and dispatched against the copy. The fixture itself is never mutated.
