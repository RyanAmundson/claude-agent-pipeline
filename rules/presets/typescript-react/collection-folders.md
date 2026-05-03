---
paths:
  - "src/**/\\[*\\]/**"
  - "src/features/*/\\[*\\]/**"
---

# Collection Folder Rules

Collection folders use `[brackets]` naming and group related modules by type. Each has strict rules about what belongs inside.

## `[models]`

Domain data definitions. No logic, no React, no side effects.

- **Models** — data shapes representing domain entities (e.g., `User`, `Organization`)
- **Enums** — named constant sets (e.g., `SessionStatus`, `FindingSeverity`)
- **Types** — type aliases, unions, intersections
- **Interfaces** — contracts for data shapes, API responses, service inputs/outputs
- **No classes** — this is a functional codebase; use plain types and interfaces
- **No functions** — no transformers, no validators, no helpers (those go in `[utils]` or `[services]`)
- **No React imports** — models are plain TypeScript

## `[utils]`

Pure utility functions. Stateless, side-effect-free, reusable.

- Small, focused helper functions (formatting, parsing, sorting, filtering, validation)
- Must be pure — same input always produces same output
- No React imports, no hooks, no state, no DOM access
- No API calls, no service imports
- If it has dependencies on domain models, it still belongs here as long as it's a pure function
- Examples: `formatDate()`, `slugify()`, `filterAndSort()`, `generateId()`

## `[contexts]`

React context + provider pairs for shared state.

- Each context module exports a Context, a Provider component, and a `useXxx()` consumer hook
- Used for state that needs to be shared across a component subtree (org selection, theme, layout, feature flags)
- Not a replacement for prop drilling when data only goes 1-2 levels deep
- Keep context values minimal — avoid stuffing entire service responses into context

## `[hooks]`

React hooks that shape data for components. See `data-pipeline.md` for the full pipeline.

- Consume services, never APIs directly
- Return ready-to-render data — components should not need to transform the result
- Handle loading/error states internally

## `[services]`

Orchestration layer over APIs. See `data-pipeline.md` for the full pipeline.

- Singleton/non-instance exports
- No React imports — plain TypeScript
- Aggregate multiple API calls into domain objects

## `[apis]`

Raw HTTP clients. See `data-pipeline.md` and `mock-data-density.md` for patterns.

- One file per endpoint group
- Every API must have a `.api.mock.ts` with density support
- No data shaping beyond what the HTTP response provides

## `[components]`

UI components (atoms, molecules, organisms). See `component-hierarchy.md` for classification.

- Receive all data via props — never fetch, never import services/APIs
- "Container" components that project children are just components, not a separate layer

## `[containers]`

Components that project children inside a layout or provider wrapper.

- Not an architectural layer — these are regular components
- Typical use: wrapping children in a layout shell, provider, or animation wrapper
- No data fetching — if it fetches data, the fetching should move to a hook

## Barrel files

- **One `index.ts` per collection folder** — aggregates exports for the collection
- **No `index.ts` inside individual module folders** — import directly from the file
- **Imports use direct paths**: `from './AgentCard/AgentCard'`, not `from './AgentCard'`
