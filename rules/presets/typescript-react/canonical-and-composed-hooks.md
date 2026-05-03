# Canonical and Composed Hooks

A naming and authoring convention for splitting server-state hooks so that
shared hooks return one canonical shape, and per-consumer shaping happens in
**separate composed hooks** that depend on the canonical hook.

This is a refinement of the React Query hook layer described in
`react-query.md`. It exists to reverse the trend where canonical hooks
accreted per-consumer logic — toast-on-error variants, sort-by-X variants,
view-model mapping for one specific table — until the canonical hook was no
longer canonical.

## The principle

Two roles, two hook shapes:

1. **Canonical hook** — the single source of truth for fetching an entity
   (or list of entities) for a feature. Returns the entity in its
   domain-shaped form. Has no UI-specific projection. Owns the query key
   factory, mock-flag injection, polling, and pagination state. Every
   feature has at most one canonical hook per entity (`useToolsQuery`,
   `useToolQuery`, `useFindingsQuery`).

2. **Composed (view) hook** — depends on a canonical hook and projects its
   output into a shape one specific consumer needs. Multiple composed hooks
   can share a canonical hook (`useToolList` for the table; `useToolDetail`
   for the detail panel; `useToolDropdown` for the picker). Composed hooks
   never call services or APIs directly — they always go through the
   canonical hook.

## Naming convention

All hooks live as flat siblings inside the feature's `[hooks]/` collection.
No sub-collections (`[hooks]/canonical/`, `[hooks]/views/` are forbidden by
the JSON-collection-shape rule — see `collection-folders.md`).

| Role | Naming | Example |
| --- | --- | --- |
| Canonical list | `use<Entity>Query` | `useToolsQuery`, `useFindingsQuery` |
| Canonical detail | `use<Entity>Query` (singular) | `useToolQuery(id)`, `useFindingQuery(id)` |
| Composed list view | `use<Entity>List` | `useToolList`, `useFindingList` |
| Composed detail view | `use<Entity>Detail` | `useToolDetail`, `useFindingDetail` |
| Composed surface-specific view | `use<Entity><Surface>` | `useToolDropdown`, `useFindingTimeline` |

The suffix `Query` marks the canonical hook. Bare names (`useToolList`,
`useFindingDetail`) are composed views. Project-wide consistency requires
one feature to migrate fully — half-migrated features that mix conventions
are confusing.

This convention is already half-deployed in `features/tools/`:
`useToolsQuery` (canonical) → `useToolList`, `useToolDetails` (views).
Future migrations follow this template.

## When to extract a composed hook

Extract a composed hook when **any one** of these is true:

1. Two or more components consume the canonical hook with the same
   transform (de-duplicates the transform, prevents drift).
2. The transform is non-trivial (filtering + sorting + computed fields) —
   keeping it inline pushes domain logic into the component.
3. The transform allocates a stable shape that a memoized child component
   depends on (`useMemo` inside the consumer becomes a hook concern).
4. The same canonical hook backs multiple distinct surfaces (table /
   dropdown / detail panel) with different projections.

Don't extract a composed hook when:

- The transform is one line and used by a single component (`tools.map(t =>
  t.name)` does not need to be a hook).
- The transform is purely visual (`tools.length === 0 ? 'empty' : 'list'`).
- The data only flows in one direction with no cross-component reuse.

## `select` vs. composed hook

TanStack's `select` option projects the cached query data without re-running
`queryFn`, and is recursively memoized. It's the right tool for **simple
projections that don't need to be a separate hook**:

```ts
// Reuse the canonical hook's cache, project on the fly.
const toolNames = useToolsQuery({ select: (data) => data.tools.map(t => t.name) });
```

Use `select` when:
- The projection is one expression, no parameters, no side concerns.
- The consumer is a single file.
- You want to avoid re-rendering when unrelated parts of the cached data
  change.

Use a composed hook (which itself often uses `select` internally) when:
- The projection is reused across multiple components.
- The projection takes parameters (filtering by props).
- The projection composes with other state (combining `useToolsQuery` with
  `useBlockedToolNames` to produce a unified list).
- The projection allocates a domain-specific view model (`ToolListItemView`).

Rule of thumb: if the projection has a name worth giving it (a noun like
"the tools-table view of the tools list"), it's a composed hook.

## Worked example: tools

### Before (current state, mostly)

```ts
// features/tools/[hooks]/useToolsQuery/useToolsQuery.ts
export function useToolsQuery(): {
  tools: ToolRecord[];
  total: number;
  isLoading: boolean;
  error: string | null;
  // ... already canonical
};
```

`useToolList` and `useToolDetails` also exist. The canonical/composed split
already works here — what it lacks is documentation and a feature-wide rule.

### After (formalized convention)

```ts
// CANONICAL — owns the cache, returns domain-shaped data.
// features/tools/[hooks]/useToolsQuery/useToolsQuery.ts
export function useToolsQuery(): {
  tools: ToolRecord[];
  total: number;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
};

// COMPOSED — table view, builds view models.
// features/tools/[hooks]/useToolList/useToolList.ts
export function useToolList(filters: ToolListFilters): {
  rows: ToolListItemView[];
  sortedBy: ToolSortBy;
  setSort: (by: ToolSortBy) => void;
  isEmpty: boolean;
};

// COMPOSED — detail panel, single tool with extras.
// features/tools/[hooks]/useToolDetail/useToolDetail.ts
export function useToolDetail(id: string): {
  tool: ToolDetailView | null;
  recentCalls: ToolCallRecord[];
  isLoading: boolean;
};

// COMPOSED — dropdown picker, just names + ids.
// features/tools/[hooks]/useToolDropdown/useToolDropdown.ts
export function useToolDropdown(): {
  options: { id: string; label: string }[];
};
```

All flat siblings inside `features/tools/[hooks]/`. Each composed hook
imports and depends on `useToolsQuery` (or `useToolQuery` for the detail
case) — never a service or an API directly.

## Migration triggers

Don't migrate a feature wholesale just to apply this convention. Migrate
when:

1. A second consumer of the canonical hook is being added — extract the
   shared transform to a composed hook *as part of that PR*.
2. The canonical hook grows past ~300 lines or owns ≥3 mutations and
   ≥2 transforms — split.
3. Two consumers diverge on the same projection (one filters by X, the
   other by Y, both copy-pasted from each other). Extract the union of
   their needs as a parametric composed hook.

## Common mistakes

- **Putting composed hooks inside `[hooks]/views/`** — sub-collection of the
  same type as `[hooks]`. Forbidden. They're flat siblings.
- **Composed hook calls a service directly** — defeats the purpose. The
  canonical hook owns the cache; composed hooks consume it.
- **Adding a `select` to the canonical hook for one consumer's benefit** —
  if the canonical hook needs to return different shapes for different
  callers, those callers need composed hooks, not branches in the canonical
  hook.
- **Returning fewer fields from the composed hook than the consumer needs,
  forcing it back to the canonical hook** — the composed hook should be
  ready-to-render. If a consumer is calling both `useToolList()` and
  `useToolsQuery()` to fill in gaps, the composed hook's contract is wrong.

## Relationship to existing rules

- `react-query.md` mandates `useQuery` for server-state hooks — that
  applies to canonical hooks. Composed hooks may or may not call
  `useQuery`; they typically don't.
- `data-pipeline.md` says hooks call services. That applies to canonical
  hooks. Composed hooks call other hooks.
- `collection-folders.md` forbids sub-collections inside `[hooks]/` —
  hence the flat-siblings naming convention.
- `useMutationWithToast` is mutation-only and orthogonal to this split.
