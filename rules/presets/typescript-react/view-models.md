# View Models

A naming and authoring convention for the **per-consumer projection layer**
that sits between domain types and rendered components.

This is the "what shape does this consumer need?" layer. Domain types
(`Tool`, `Agent`, `Finding`) describe the entity. View models describe a
specific surface's view of the entity (table row, detail header, dropdown
option, sidebar tile).

## The principle

Three altitudes of types:

| Layer | Lives in | Casing | Purpose |
|---|---|---|---|
| **Raw API** | `[apis]/<X>/<X>.api.types.ts` | snake_case (matches backend) | Exact wire format |
| **Domain** | `[models]/<x>/<x>.ts` | snake_case or camelCase | Normalized entity (after services) |
| **View model** | `[utils]/<x>ViewModels/<x>ViewModels.ts` | camelCase | Per-consumer projection |

A view model is a **named projection** of one or more domain entities into
the exact shape one consumer renders. View models exist to:

1. Stop components doing computation. Components render; view models
   compute.
2. De-duplicate transforms. If two components project the same way,
   that projection is a named view model, not two copies.
3. Make consumer needs visible. The view model's name encodes who needs
   it and at what surface.

## Naming convention

`<Entity><Surface>View`. The entity name comes first, the surface comes
second, the literal suffix `View` makes it findable.

| View model | Used by |
|---|---|
| `ToolListItemView` | Tools page table row |
| `ToolDetailView` | Tools detail panel |
| `ToolDropdownOptionView` | Tool picker dropdown |
| `AgentSidebarTileView` | Agent sidebar entry |
| `FindingTableRowView` | Findings table row |
| `FindingTimelineEntryView` | Findings timeline entry |

The entity prefix is required even when the file is inside that entity's
folder — `ToolListItemView` rather than `ListItemView` — because consumers
import these by name and the prefix prevents collisions when two features'
view models meet (e.g., a component that displays both findings and
violations side by side).

## When to extract a view model

Extract when **any one** of these is true:

1. **Two components project the same shape.** Move the projection to a
   named view model so the second component can import it.
2. **The projection has computed fields.** Anything beyond field renames
   (totals, percentages, status mappings, derived dates) belongs in a
   view model rather than inline in the component.
3. **The projection takes parameters.** Filtering by props, mapping by
   status, conditional fields — these are parametric view models, not
   inline expressions.
4. **The component would otherwise import the domain type AND mutate it.**
   Components don't transform domain types; they consume view models.

Don't extract when:

- The projection is a single field-rename. `tool.tool_id → tool.id` lives
  in the service, not a view model.
- The component is one-off and the projection is one expression.
- The "projection" is just `tools.length` — that's not a view model, it's
  a render expression.

## Where view models live

Per the collection-folder rules:

```
features/<feature>/[utils]/<entity>ViewModels/<entity>ViewModels.ts
features/<feature>/[utils]/<entity>ViewModels/__tests__/<entity>ViewModels.test.ts
```

One file per entity, multiple view models per file. The file holds:

- The view-model interfaces themselves
- Pure mapping functions (`toToolListItemView(tool: ToolRecord): ToolListItemView`)
- Helper enums / status mappers used by those functions

Tests for view models go in the adjacent `__tests__/` folder. View-model
mappers are pure functions — easy to test and worth testing because they
encode product decisions ("a tool with 0 sessions shows successRate 0,
not NaN").

## Who calls view-model mappers

Composed (view) hooks call them. The hook receives canonical-shape data
from `useEntityQuery` / `useFooQuery`, runs the mapper, and returns the
view-model array to the consumer:

```ts
// features/tools/[hooks]/useToolList/useToolList.ts
export function useToolList(filters: ToolFilters) {
  const { state } = useToolsQuery({ filters });
  const rows: ToolListItemView[] = useMemo(
    () => state.status === 'success' ? state.data.tools.map(toToolListItemView) : [],
    [state]
  );
  return { rows, state };
}
```

Components don't call mappers themselves. If a component needs a view
model, it calls a composed hook that returns one.

## Worked example: tools

`features/tools/[utils]/toolViewModels/toolViewModels.ts` already
exemplifies the pattern:

- `ToolListItemView` — table row shape
- `mapStatusToBadge`, `mapStatusToLabel`, `inferActionCategory` — helpers
- `toToolListItemView(record: ToolRecord): ToolListItemView` — the mapper

Future expansion (when the surfaces appear):

- `ToolDetailView` — when the detail panel needs more than the list row
- `ToolDropdownOptionView` — when a picker selects tools

## Common mistakes

- **Components computing view-model fields inline** — move to a mapper.
- **Naming the view model after the component** — wrong. Name after the
  surface (`ToolListItem`, not `ToolsTableRow` even though it's used by
  `ToolsTable.tsx`).
- **Returning view models from canonical query hooks** — wrong. Canonical
  hooks return domain shape; composed hooks project to view models.
- **Computing view-model fields in `select`** — usually wrong. `select`
  is for tiny projections. Multi-field view models with names belong in
  named view-model files so they're testable and discoverable.
- **Mutating the underlying domain object** — wrong. View-model mappers
  return new objects. Never mutate.

## Relationship to existing rules

- `data-pipeline.md` — services own domain shape; hooks own view-model
  shape. View-model mappers run in the hook, not the service.
- `canonical-and-composed-hooks.md` — composed hooks call view-model
  mappers; canonical hooks don't.
- `naming-conventions.md` — file path is `[utils]/<entity>ViewModels/<entity>ViewModels.ts`.
