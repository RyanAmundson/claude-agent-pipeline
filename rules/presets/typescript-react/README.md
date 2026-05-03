# TypeScript + React Preset

Opinionated rules for a TypeScript / React 19+ / Vite / TanStack Query stack. Originally extracted from a production codebase that uses these conventions across ~250 React components.

## What's in here

| Rule | What it enforces |
|------|------------------|
| `data-pipeline.md` | Strict 4-layer flow: API → Service → Hook → Component. No layer skipping. |
| `react-query.md` | TanStack Query for all server state. Forbids `useState`+`useEffect` for fetching. |
| `view-models.md` | Per-consumer projection layer between domain types and rendered components. |
| `canonical-and-composed-hooks.md` | One canonical `use<Entity>Query` per entity; composed hooks for per-surface views. |
| `naming-conventions.md` | File and folder naming (PascalCase modules, kebab-case features, `[brackets]` for collections). |
| `collection-folders.md` | What lives in `[components]/`, `[hooks]/`, `[services]/`, `[apis]/`, `[utils]/`, `[models]/`. |
| `component-hierarchy.md` | Pages → containers → components → primitives. |
| `mock-data-density.md` | Empty / sparse / dense fixture density tiers for development and tests. |
| `e2e-testing.md` | Playwright spec organization and helper conventions. |
| `playwright-mcp.md` | Playwright MCP usage patterns for agent-driven exploration. |

## Installing

```bash
npx agent-pipeline install <target-project> --preset typescript-react
```

## Customizing

These rules reflect specific opinions (TanStack Query > SWR, view-model layer between domain and component, `[brackets]` collection folders). If your project disagrees, copy the rule into your local `.claude/rules/` and edit, or omit the rule from your install (`agent-pipeline install … --preset typescript-react --omit-rule react-query`).
