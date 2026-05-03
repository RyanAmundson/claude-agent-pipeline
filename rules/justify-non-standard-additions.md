---
---

# Justify Non-Standard Additions

Some changes silently degrade application quality: parallel systems, copy-pasted utilities, abstractions that bypass established patterns, hardcoded constants where a system already exists. They don't fail tests or trip lint — they just rot the codebase.

**Rule**: If a change you are about to make matches any trigger below, you MUST stop and explicitly justify the choice — in the PR description, the commit body, or directly in the response — *before* writing the code. If you cannot articulate the justification, the decision is wrong: use the existing system, function, or pattern instead.

This applies to humans and agents equally. Agents working autonomously must include the justification block in their PR body under a `## Justification` heading whenever any trigger fires.

## Triggers — these require justification

### Reuse / parallel-system triggers

1. **Reinventing a common function.** You are writing a utility (formatter, parser, comparator, debounce, deep-equal, id generator, classname merger, fetch wrapper, etc.) from scratch. → First check `[utils]/`, the feature's own `[utils]/`, and existing third-party deps (lodash, date-fns, clsx, etc.). If you proceed, justify why none fits.
2. **Duplicating a domain type / enum / model.** You are defining a type that names an existing entity (`Agent`, `Endpoint`, `Finding`, `Policy`, `Order`, `Account`, status enums, etc.). → Per CLAUDE.md "Domain Model Ownership", import from the owner. Local copies are forbidden — never justify, just import.
3. **Duplicating an API call.** You are writing `fetch`/axios/api code for an endpoint that already has a function in `[apis]/`. → Use the existing one. If it's missing a field, extend it; don't fork.
4. **New parallel system where one exists.** You are introducing a new pattern for something the codebase already has a system for: server state (use React Query, not `useState`+`useEffect`), mutations (use `useMutationWithToast`), polling (use `refetchInterval`), client filtering (use `useDeferredValue`), toast (use `useToast`), forms, modals, dialogs, navigation, error boundaries. → See `react-query.md`, `data-pipeline.md`. Use the established system.

### Modularity / layering triggers

5. **Layer violation.** Component imports from `[apis]` or `[services]`; hook imports from `[apis]`; service imports from React; service does UI work (toast/state/components). → Forbidden by `data-pipeline.md`. Restructure — don't justify.
6. **Cross-feature reach-around.** You are importing from another feature's `[components]/`, `[hooks]/`, or `[services]/` internals (not its barrel). → Import via the barrel, or move the shared piece up to `src/[components]/`, `src/[hooks]/`, etc.
7. **Computation in component.** You are putting transforms, filters, sorts, derived totals, or status mapping inside a `.tsx` file. → Move to a hook (`[hooks]/`) or view-model mapper (`[utils]/<entity>ViewModels/`). See `view-models.md`.
8. **Canonical hook bloat.** You are adding per-consumer projection / sort / view-model logic into a `use<Entity>Query` hook. → Extract a composed hook (`use<Entity>List`, `use<Entity>Detail`). See `canonical-and-composed-hooks.md`.

### "Quiet rot" triggers

9. **New dependency.** Adding to `package.json`. → Justify why an existing dep can't do it. Cost: bundle size, supply-chain surface, future upgrade burden.
10. **New abstraction with one caller.** Introducing a wrapper, factory, base class, or helper used in exactly one place. → Inline it. Three similar lines is better than a premature abstraction.
11. **Bypassing an established convention.** Choosing a different file/folder casing, a different test runner, a different state pattern, a different error pattern than the rest of the codebase uses. → See `naming-conventions.md`, `collection-folders.md`. Match the codebase or justify the divergence.
12. **Disabling a guardrail.** `eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `--no-verify`, skipping a pre-commit hook, `.skip` on a test, `expect.fail` workaround. → Fix the underlying issue. If you must suppress, justify in a comment that names the root cause and the ticket tracking the real fix.
13. **Hardcoded value where a system exists.** Inlining a constant, URL, role name, feature flag value, or magic number that should come from config, env, the glossary, or an enum. → Use the system.
14. **Silent error catching.** `try { ... } catch { }` or `.catch(() => {})` that swallows the error without logging or surfacing. → Forbidden (see auto-memory `feedback_no_silent_catches`). Surface the error via `useToast` or `console.error` at minimum.
15. **Misleading fallbacks.** `?? defaultValue` / `|| fallback` that hides a missing field by showing wrong-but-plausible data instead of an error or loading state. → Surface the missing data, don't paper over it (see `feedback_no_wrong_fallbacks`).
16. **Arbitrary numeric limits.** `slice(0, 10)`, `limit: 50`, `take(20)` hardcoded into hooks/services without pagination. → Use real pagination. See `feedback_no_arbitrary_limits`.
17. **Defensive code for impossible cases.** Validating internal call sites, guarding against types the type system already enforces, fallbacks for unreachable branches. → Trust the types and framework. Validation belongs only at system boundaries (user input, external APIs).
18. **Backwards-compatibility shim with no caller.** Re-exporting a removed type as a deprecated alias, leaving `// removed for X` comment, renaming `_unusedVar` instead of deleting. → Just delete the dead code.
19. **Skipping the bug-fix regression test.** Fixing a bug without a vitest unit test or Playwright E2E that reproduces it. → Forbidden by CLAUDE.md "Bug Fix Testing Rule". Always required.
20. **Working around a failure instead of diagnosing it.** Deleting an untracked file to satisfy a hook, force-pushing past a CI failure, swallowing a flaky test, replacing a failing assertion with `.toBeTruthy()`. → Diagnose root cause. See CLAUDE.md "Git Safety Rules".

## How to justify (when a trigger applies)

Write a `## Justification` block (in the PR description, commit body, or in-conversation if no PR yet) covering:

- **What I'm doing**: the non-standard choice in one sentence.
- **Existing alternative I considered**: name the file, function, hook, or pattern.
- **Why it doesn't fit**: concretely — missing field, wrong layer, performance, scope. "It's old" or "I prefer this style" are not reasons.
- **Tradeoff I'm accepting**: bundle size, parallel maintenance, future migration cost.

Example:

> ## Justification
> **What**: Adding a new `formatRelativeTime()` helper in `features/sessions/[utils]/`.
> **Considered**: `date-fns/formatDistanceToNow` (already a dep) and `[utils]/format/timeFormat.ts`.
> **Why not**: `formatDistanceToNow` returns "about 2 hours ago"; product wants exact minute precision ("2h 14m ago"). `timeFormat.ts` is absolute-time only.
> **Tradeoff**: One more formatter in the codebase. Acceptable because the surface (session age in the live log) is high-traffic and the existing options would each require a wrapper anyway.

## When NO justification is needed

- Editing an existing file in place to fix a bug or add a field to an existing type.
- Wiring an existing utility/hook/service to a new caller.
- Adding tests, docs, or feature flags via the established systems.
- Pure renames, mechanical refactors that preserve behavior, or generator-produced files (`npm run generate ...`).

## Why this rule exists

Every parallel system, copy-pasted utility, and one-off abstraction looks reasonable at the moment of writing. In aggregate they are how the codebase gets worse: two date formatters, three toast systems, four ways to fetch agents, type definitions that drift out of sync. The justification step is friction by design — it forces a deliberate choice instead of an absent-minded one, and it leaves a written record that future readers (and reviewers) can audit.
