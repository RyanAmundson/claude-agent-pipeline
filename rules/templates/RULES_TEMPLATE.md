---
name: <rule-name-in-kebab-case>
severity: high | medium | low
applies_to: <glob patterns or file types this rule covers, e.g. "src/**/*.tsx">
---

# <Rule Title>

> **Status**: This is a template. Copy this file to a new `<your-rule-name>.md` and fill in the fields below.

## What

A 1–2 sentence description of the pattern this rule flags. Concrete enough that a reader knows what would and wouldn't match.

## Why

Why this pattern is a problem. The motivation matters more than the pattern itself — the scanner uses this to judge edge cases.

- What goes wrong when this pattern is present?
- What past incident or recurring bug class motivated the rule?

## Pattern

How the scanner detects the violation. Pick one:

### Option A: regex

```
<a regex that matches the violation>
```

Example violations:

- `value ?? 0` (matches `value\s*\?\?\s*0`)

### Option B: AST hint

Describe the AST shape the scanner should look for. The scanner uses this as a natural-language hint, not a strict matcher.

> Find any TypeScript expression of the form `<member-access> ?? <numeric-literal>` where `<member-access>` is on a value typed as `Response` or a subtype.

### Option C: heuristic

A natural-language description of the smell. Use this when neither regex nor AST cleanly captures it.

> Find any function whose name starts with `fetch` or `load` that catches an exception and returns a default value without re-throwing or logging.

## Example violation

```typescript
// BAD: silent fallback hides a real error as "0 users"
const users = response.users ?? 0;
```

## Example fix

```typescript
// GOOD: surface the error explicitly
if (response.users === undefined) {
  throw new Error('Missing users in response');
}
const users = response.users;
```

## Exceptions

When this rule shouldn't fire:

- <case where the pattern is intentional and correct>
- <case where the fix is more complex and out of scope for the rule>

## Notes for the scanner

Optional hints to keep false-positives down:

- Skip this rule for files in `**/test/**` or `**/__mocks__/**`.
- Skip when the fallback is followed by an explicit error-state surfacing within the same function.
