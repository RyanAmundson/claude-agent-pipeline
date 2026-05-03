---
name: no-silent-error-catching
severity: high
applies_to: src/**/*.{ts,tsx,js,jsx}
---

# No Silent Error Catching

## What

Catch blocks that swallow the error without surfacing it — no toast, no log, no re-throw, no error state passed to callers.

## Why

Silent catches mask real bugs. Users see UI that looks fine but is missing data, or the app silently degrades. Debugging becomes nearly impossible because the error was caught and forgotten.

## Pattern

### Option A: regex

```
}\s*catch\s*\([^)]*\)\s*\{\s*}
```

(catches empty catch blocks)

### Option B: heuristic

Find any `catch` block whose body contains only `console.error` (or equivalent debug logging) and no other action — no toast, no setError, no re-throw, no status return.

## Example violation

```typescript
async function loadUserStats() {
  try {
    return await fetch('/api/stats').then(r => r.json());
  } catch (err) {
    console.error(err); // silent — caller sees `undefined` and renders empty stats
  }
}
```

## Example fix

```typescript
async function loadUserStats() {
  try {
    return await fetch('/api/stats').then(r => r.json());
  } catch (err) {
    showToast({ title: 'Failed to load stats', variant: 'destructive' });
    throw err; // let caller decide what to do
  }
}
```

Or, return a structured result:

```typescript
async function loadUserStats(): Promise<{ data: Stats | null; error: Error | null }> {
  try {
    const data = await fetch('/api/stats').then(r => r.json());
    return { data, error: null };
  } catch (error) {
    return { data: null, error: error as Error };
  }
}
```

## Exceptions

- Catches in test setup/teardown that are documented as "best effort" cleanup
- Catches inside a logging library's own internal flush logic (must not throw further)

## Notes for the scanner

- Skip files matching `**/test/**`, `**/__mocks__/**`, `**/*.spec.{ts,tsx}`.
- A catch that only `console.error`s but the function explicitly returns `undefined` and the caller pattern-matches on `undefined` to render an error state is a borderline case — flag at `medium` instead of `high`.
