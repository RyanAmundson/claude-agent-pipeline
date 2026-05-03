---
name: no-debug-remnants
severity: medium
applies_to: src/**/*.{ts,tsx,js,jsx,go,rs,py}
---

# No Debug Remnants

## What

`console.log`, `print(`, `println!`, `fmt.Println`, `debugger` statements, and breakpoint markers that were left in production code paths.

## Why

Debug output pollutes user-facing logs, leaks information, and signals incomplete work. `debugger` statements halt execution in dev tools.

## Pattern

### Option A: regex (per language)

JavaScript/TypeScript:
```
\bconsole\.(log|debug|info)\(|\bdebugger\b
```

Go:
```
\bfmt\.Println\(
```

Rust:
```
\bdbg!\(|\bprintln!\(
```

Python:
```
^\s*print\(
```

## Example violation

```typescript
function processOrder(order: Order) {
  console.log('processing', order); // debug remnant
  debugger; // halts dev tools
  return chargeCustomer(order);
}
```

## Example fix

Remove the debug calls. If logging is needed, use the project's logger:

```typescript
function processOrder(order: Order) {
  logger.info({ orderId: order.id }, 'processing order');
  return chargeCustomer(order);
}
```

## Exceptions

- Files in `**/scripts/**`, `**/cli/**` where stdout is the intended output channel
- Test files (`*.spec.{ts,tsx}`, `*.test.{ts,tsx}`)
- Logging configured behind a flag (`if (process.env.DEBUG) console.log(...)`)

## Notes for the scanner

- Don't flag `console.error` or `console.warn` — those are legitimate even in production (they go to error monitoring).
- Don't flag inside string literals or comments.
