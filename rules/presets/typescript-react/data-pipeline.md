---
---

# Data Pipeline Architecture

All data flows through exactly four layers. Each layer has strict boundaries — never skip a layer or mix responsibilities.

```
API → Service → Hook → Component
```

## API Layer (`[apis]/*.api.ts`)

**Strict 1:1 mirror of the backend swagger.** Every exported function maps to exactly one backend endpoint and returns the raw JSON the backend sends.

- One file per endpoint group, with a matching `.api.mock.ts` for density support
- Types in `.api.types.ts` must exactly match the backend response schema (snake_case field names, same structure)
- Zod schemas in `.api.schema.ts` validate the response shape but do not transform it
- `createGuardedApi` wraps real/mock routing — this is infrastructure, not transformation
- Query-parameter building (constructing `URLSearchParams` from function args) is allowed — it's URL formatting, not data reshaping

### What MUST NOT be in API files

- `normalize*()` functions or any field aliasing/renaming
- `.map()` calls that add, remove, or rename fields on the response
- Computed or derived fields (e.g., calculating `successRate` from other fields)
- Default value injection (e.g., `?? false`, `|| 'unknown'` on response data)
- Fallback extraction (e.g., `response.tools ?? response.items ?? response.entries`)
- Facade methods that combine multiple endpoints into one function
- `any` casts followed by reshaping

**If you need to reshape, normalize, or aggregate data — put it in the Service layer.**

## Service Layer (`[services]/*Service.ts`)

**The facade layer.** Orchestrates API calls, normalizes responses, and aggregates data into domain-shaped objects.

- **Singleton/non-instance** — export a single object or use a class with a singleton export (`export const fooService = new FooService()`)
- **No React imports** — services are plain TypeScript, never import from React
- **No UI concerns** — no toast, no state, no components
- Use `Promise.all()` when fetching from multiple APIs in parallel
- Returns domain objects ready for hooks to consume
- This is the only layer that should call API functions
- **All normalization happens here** — field aliasing (snake_case → camelCase), computed fields, null-to-empty coercion, response aggregation
- Normalizer utilities live in the feature's `[utils]/` folder and are imported by services — never by API files

```typescript
export class SecurityPostureService {
  async getPosture(orgId: string): Promise<SecurityPostureData> {
    const [findings, groups, policies] = await Promise.all([
      findingsApi.getStats(),
      acgApi.getGroups(orgId),
      policyApi.getPolicies(orgId),
    ]);
    return { findings, groups, policies };
  }
}

export const securityPostureService = new SecurityPostureService();
```

## Hook Layer (`[hooks]/use*.ts`)

Consumes services and shapes results into exactly what a specific component needs. The component should receive a ready-to-render result with no leftover computation.

- **Imports services, never APIs** — hooks call services, not API functions directly
- **Shapes data for the UI** — transforms, filters, derives computed values so the component doesn't have to
- **Handles loading/error states** — returns `{ data, loading, error }` or similar
- **Error feedback via `useToast()`** — catch errors from services and show user-facing messages
- **Uses `useCallback`** for async operations with proper dependency arrays
- **Uses `useRef`** for stable references across renders (e.g., tracking registration, storing latest config)
- **Uses `useMemo`** for derived/filtered/sorted data
- **Cleanup in `useEffect` returns** — unsubscribe from events, unregister handlers

```typescript
export function useSecurityPosture(orgId: string) {
  const [data, setData] = useState<PostureForChart | null>(null);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      const raw = await securityPostureService.getPosture(orgId);
      setData(transformForChart(raw)); // shape for the component
    } catch (error) {
      toast({ title: 'Error', description: 'Failed to load posture', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [orgId, toast]);

  useEffect(() => { refresh(); }, [refresh]);

  return { data, loading, refresh };
}
```

## Component Layer (`*.tsx`)

Renders what the hook gives it. No data fetching, no API calls, no service imports.

- Receives data via props or calls a hook — never imports from `[apis]` or `[services]`
- No `fetch`, no `axios`, no service function calls
- Minimal internal state (UI-only: hover, selection, open/closed)
- "Container" components (like `LayoutContainer`, `WizardContainer`) are just components that project children — they are not a separate layer

## Layer boundary violations to avoid

- Component importing from `[apis]` or `[services]` — use a hook instead
- Hook importing from `[apis]` — use a service instead
- Service importing from React — services are plain TypeScript
- Service doing UI work (toast, state) — that belongs in the hook
- Component doing data aggregation or transformation — move it to the hook
