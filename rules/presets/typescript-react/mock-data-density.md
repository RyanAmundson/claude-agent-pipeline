---
paths:
  - "**/*.mock.ts"
  - "**/*.empty.ts"
  - "**/*.sparse.ts"
  - "**/*.dense.ts"
  - "**/[apis]/**"
  - "src/[utils]/mock/**"
---

# Mock Data & Density Fixtures

The app uses a **data density system** that lets each mock service return different amounts of data (`empty`, `sparse`, `dense`) for testing. There are two patterns, depending on file complexity.

## Pattern 1: Inline presets (small mock files)

For simple mock files with minimal data, use `createDensityPresets` directly inside the `.mock.ts` file. No separate fixture files needed.

```typescript
// AgentService.mock.ts
import { createDensityPresets } from '@/[utils]/mock/density-presets';

const agentListPreset = createDensityPresets<Agent[]>(
  {
    empty: () => [],
    sparse: () => Array.from({ length: 3 }, (_, i) => generateAgent(i)),
    dense: () => Array.from({ length: 75 }, (_, i) => generateAgent(i)),
  },
  'my-service-key'
);
```

**Reference**: `src/[apis]/agent-api/agentApi.mock.ts`, `src/[apis]/policy-api/policyApi.mock.ts`

## Pattern 2: Co-located density fixture files (large mock files)

When a `.mock.ts` file grows large (500+ lines), extract the data into three co-located density fixture files.

**File naming**: Fixture files sit next to the `.mock.ts` and use the same base name with a density suffix:

| File            | Purpose                                                                       |
| --------------- | ----------------------------------------------------------------------------- |
| `Foo.mock.ts`   | Types, service class, singleton export, `AgentControlGroupFixtures` interface |
| `Foo.empty.ts`  | Returns empty collections / zeroed stats                                      |
| `Foo.sparse.ts` | Returns 2-3 hand-crafted, realistic items per collection                      |
| `Foo.dense.ts`  | Returns 50-60+ generated items per collection                                 |

**Shared fixture interface**: Defined and exported from the `.mock.ts` file so all three density files import it:

```typescript
// Foo.mock.ts
export interface FooFixtures {
  items: FooItem[];
  relatedData: (itemId: string) => RelatedItem[];
  statistics: (itemId: string) => FooStats;
}
```

Each density file exports a single `createFixtures()` factory function:

```typescript
// Foo.empty.ts
import type { FooFixtures } from './Foo.mock';
export function createFixtures(): FooFixtures { /* ... */ }
```

The `.mock.ts` file resolves the correct fixture at initialization:

```typescript
// Foo.mock.ts
import { createFixtures as createEmptyFixtures } from './Foo.empty';
import { createFixtures as createSparseFixtures } from './Foo.sparse';
import { createFixtures as createDenseFixtures } from './Foo.dense';

function getFixturesForDensity(mode: string): FooFixtures {
  switch (mode) {
    case 'empty':
    case 'real':
      return createEmptyFixtures();
    case 'sparse':
      return createSparseFixtures();
    case 'dense':
      return createDenseFixtures();
    default:
      return createSparseFixtures();
  }
}
```

**Reference**: `src/features/agent-control-groups/[apis]/AgentControlGroup/`

## When to split into fixture files

- The `.mock.ts` exceeds ~500 lines
- It contains large static data arrays (seed groups, hand-crafted entries)
- It has generator functions that are only used during initialization, not runtime mutations
- Subsidiary data (allowlists, audit logs, stats) varies significantly between density modes

### What stays in `.mock.ts`

- Type/interface exports (consumed across the app)
- The service class and singleton export
- Runtime mutation generators (e.g., `generateMockAllowlistEntry` used by `addToAllowlist()`)
- Generator functions used externally (keep them exported)

### What moves to density files

- Static seed data arrays (`BASE_ITEMS`, `MOCK_ENTRIES`, etc.)
- Initialization-only generator helpers (batch generators, activity generators)
- Density-specific item counts and configuration

## Key infrastructure files

| File                                     | Purpose                                                                    |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| `src/[utils]/mock/density-presets.ts`    | `createDensityPresets()` helper for inline pattern                         |
| `src/[utils]/mock/data-density.ts`       | `DataDensityMode` type, count configs, `generateCountForDensity()`         |
| `src/[utils]/mock/generators.ts`         | Shared generators: `generateId`, `generatePerson`, `generateDate`, etc.    |
| `src/[utils]/mock/base-service.ts`       | `BaseMockService<T>` — abstract base with density-aware `initializeData()` |
| `src/[utils]/mock/mock-flag-resolver.ts` | Resolves current density mode per service key                              |

## CRITICAL: New APIs Must Use the Data Density System

**IMPORTANT**: Every new API endpoint added to the app MUST support the data density system. This is not optional — all four density modes (`real`, `empty`, `sparse`, `dense`) must be implemented.

### Required file structure for new APIs

```
features/<feature>/[apis]/<ApiName>/
├── <ApiName>.api.ts          # Real API client (fetch/axios calls)
├── <ApiName>.api.mock.ts     # Mock service with density support
├── index.ts                  # Barrel exports
└── __tests__/                # Tests
```

If the mock file grows large (500+ lines), split into density fixture files:

```
features/<feature>/[apis]/<ApiName>/
├── <ApiName>.api.ts
├── <ApiName>.api.mock.ts     # Service class + density resolution
├── <ApiName>.api.empty.ts    # Empty state fixtures (no data)
├── <ApiName>.api.sparse.ts   # Sparse fixtures (1-3 items)
├── <ApiName>.api.dense.ts    # Dense fixtures (50+ items)
├── index.ts
└── __tests__/
```

### All four density modes are required

| Mode     | What it returns                        | Purpose                                 |
| -------- | -------------------------------------- | --------------------------------------- |
| `real`   | No mock data (passthrough to real API) | Production behavior                     |
| `empty`  | Empty arrays / zeroed stats            | Test empty states, no-data UI           |
| `sparse` | 1-3 hand-crafted, realistic items      | Default dev experience, readable data   |
| `dense`  | 50+ generated items                    | Scroll, pagination, performance testing |

### Checklist for new API endpoints

1. Create the `.api.ts` with the real API client
2. Create the `.api.mock.ts` with density support using either:
   - **Inline presets** via `createDensityPresets` (for simple endpoints), or
   - **Co-located fixture files** (`.empty.ts`, `.sparse.ts`, `.dense.ts`) for complex endpoints
3. Verify all four modes work: `real`, `empty`, `sparse`, `dense`
4. Register the mock service key so the density toggle in the UI can control it
5. Use shared generators from `src/[utils]/mock/generators.ts` where possible

### Do NOT skip density support

- Do not create a mock file that only returns a single hardcoded dataset
- Do not create an API without a corresponding `.mock.ts` file
- Do not add a new density mode — the four modes above are the only supported modes
