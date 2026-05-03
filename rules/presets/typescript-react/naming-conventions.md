---
---

# Terminology

**Canonical glossary**: See `docs/glossary.md` for authoritative definitions of all the project's domain terms. Always consult it before using or defining project-specific terminology.

# File & Folder Naming Conventions

**Core rule**: The folder name always matches its primary file name, including casing.

## File type classification

- `index` - index.ts/index.tsx
- `mock` - \*.mock.ts
- `density-fixture` - \*.empty.ts, \*.sparse.ts, \*.dense.ts
- `test` - \*.test.ts/tsx
- `story` - \*.stories.tsx
- `type` - types.ts, \*.d.ts
- `context` - \*Context.tsx
- `service` - \*Service.ts
- `hook` - use\*.ts
- `component` - \*.tsx (default)
- `util` - \*.ts (default)
- `style` - \*.css
- `config` - \*.json
- `doc` - \*.md

## Folder naming

| Folder type                              | Casing                                     | Examples                                                           |
| ---------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------ |
| Collection dirs                          | `[brackets]` + kebab-case                  | `[components]`, `[services]`, `[hooks]`, `[models]`, `[utils]`     |
| Feature folders                          | kebab-case                                 | `agent-control-groups`, `feature-flags`, `security-posture`        |
| Sub-group folders (within collections)   | kebab-case                                 | `dashboard`, `filters`, `wizard`, `shared`                         |
| Component/service/context module folders | PascalCase (matches file)                  | `AgentControlGroupCard/`, `PolicyService/`, `PolicyFilterContext/` |
| Hook module folders                      | camelCase with `use` prefix (matches file) | `useSlideOutPanel/`, `useDebouncedValue/`                          |
| Model/type module folders                | camelCase (matches file)                   | `policy/`, `agentAppIcons/`, `securityDataTransformers/`           |

## File naming

| File type       | Pattern                              | Example                                    |
| --------------- | ------------------------------------ | ------------------------------------------ |
| Component       | `PascalCase.tsx`                     | `AgentControlGroupCard.tsx`                |
| Hook            | `useCamelCase.ts`                    | `useSlideOutPanel.ts`                      |
| Service         | `PascalCaseService.ts`               | `PolicyService.ts`                         |
| Context         | `PascalCaseContext.tsx`              | `PolicyFilterContext.tsx`                  |
| Model/type      | `camelCase.ts`                       | `policy.ts`, `securityDataTransformers.ts` |
| Test            | `PascalCase.test.tsx` or `test.tsx`  | `StatCard.test.tsx`                        |
| Story           | `PascalCase.stories.tsx`             | `StatCard.stories.tsx`                     |
| Mock            | `PascalCase.mock.ts`                 | `PolicyService.mock.ts`                    |
| Density fixture | `PascalCase.{empty,sparse,dense}.ts` | `AgentControlGroup.api.empty.ts`           |
| Barrel          | `index.ts` (collection-level only)   | `[components]/index.ts`                    |

## Anti-patterns to avoid

- **Mismatched folder/file casing**: `agentCard/AgentCard.tsx` is wrong — use `AgentCard/AgentCard.tsx`
- **kebab-case for module folders**: `agent-control-group-card/` is wrong — use `AgentControlGroupCard/` for component modules
- **Redundant nesting**: Don't create `[components]/feature-name/` inside `features/feature-name/` — the feature context is already implied

For barrel file rules and what belongs in each collection folder, see `collection-folders.md`.
