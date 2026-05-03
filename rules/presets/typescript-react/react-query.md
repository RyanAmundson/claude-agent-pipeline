# React Query (TanStack Query) Conventions

## Core Rule

All new hooks that consume server data MUST use `useQuery` / `useMutation` from `@tanstack/react-query`. The manual `useState` + `useEffect` + `useCallback` + `isMountedRef` pattern is deprecated for server-state hooks.

## 4-Layer Pipeline — Preserved

```
API → Service → Hook (useQuery) → Component
```

- `queryFn` calls **services**, never API functions directly
- Services remain plain TypeScript — no React imports, no UI concerns
- Hooks shape results for components — components do no computation

## Query Key Factory Pattern

Each feature owns its query keys. Define them adjacent to the hook that uses them.

```typescript
export const featureKeys = {
  all: ['feature'] as const,
  lists: () => [...featureKeys.all, 'list'] as const,
  list: (filters: FilterState) => [...featureKeys.lists(), filters] as const,
  details: () => [...featureKeys.all, 'detail'] as const,
  detail: (id: string) => [...featureKeys.details(), id] as const,
};
```

Reference: `src/features/tools/[hooks]/useToolsQuery/useToolsQuery.ts`

## Mock/Density Toggle Support

Include `{ mock: isUsingMockData }` in query keys so toggling density mode triggers a refetch:

```typescript
const queryKey = [...featureKeys.list(filters), { mock: isUsingMockData }];
```

## Mutations

Use `useMutationWithToast` from `@/[utils]/query` for **all** mutations. Raw
`useMutation` is forbidden outside the helper itself — enforced by
the appropriate ESLint rule.

```typescript
const createItem = useMutationWithToast({
  mutationFn: (data: CreateRequest) => service.create(data),
  successMessage: 'Item created',
  invalidateKeys: [featureKeys.lists()],
});
```

### Invalidation discipline: list AND detail

When a mutation touches a single entity by id, **invalidate both** the list
and the detail caches for that entity. Invalidating only `.lists()` lets the
per-entity `detail(id)` cache drift from server state until the next manual
refresh — the detail page will show stale data after a successful mutation.

**Required pattern** for single-entity mutations:

```typescript
const updateAgent = useMutationWithToast({
  mutationFn: (vars: { agentId: string; data: UpdateAgentRequest }) =>
    agentService.updateAgent(vars.agentId, vars.data),
  successMessage: 'Agent updated',
  // Both — never just .lists().
  invalidateKeys: vars => [agentsKeys.detail(vars.agentId), agentsKeys.lists()],
});
```

For mutations that don't carry an entity id (creates, batch operations),
invalidating `featureKeys.lists()` (and optionally `featureKeys.all` for
broader sweeps) is sufficient — there's no specific detail to invalidate.

**Anti-pattern**: a single-id mutation whose `invalidateKeys` only contains
`featureKeys.lists()`. The detail cache will be stale until the user
navigates away and back.

This is enforced by the appropriate ESLint rule (see
`<your-eslint-plugin>/lib/rules/<rule>.js`).

## Polling

Use `refetchInterval`, not `setInterval` or `useAgentLiveUpdates`:

```typescript
useQuery({
  queryKey: featureKeys.list(filters),
  queryFn: () => service.getAll(),
  refetchInterval: 10_000, // 10 seconds
});
```

For visibility-aware polling (pause when tab hidden), use `useVisibilityAwareInterval()`.

## What NOT to Use

- `isMountedRef` — React Query handles component unmount cancellation
- `latestFetchIdRef` — React Query handles race conditions via query keys
- `networkDebugLogger.hookFetch` — React Query DevTools replaces this
- `setInterval` for polling — use `refetchInterval`
- Manual `try/catch` with `setLoading`/`setError` — `useQuery` provides `isLoading`/`error`

## Client-Side Filtering

- Use `useDeferredValue` for client-side list/table filtering (keeps input responsive)
- Use `useDebouncedValue` **only** for debouncing actual API calls
- Do NOT use `setTimeout(300)` or `useDebouncedValue` for client-side filtering

## Return Type Compatibility

Migrated hooks must preserve their existing return shape. Map React Query state to the existing interface:

```typescript
return {
  data: query.data ?? defaultValue,
  loading: query.isLoading,       // or isLoading — match existing name
  error: query.error?.message ?? null,
  refetch: query.refetch,
};
```
