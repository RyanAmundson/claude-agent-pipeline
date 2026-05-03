---
paths:
  - "src/**/*.tsx"
  - "src/**/*.stories.tsx"
---

# Component Hierarchy

**Canonical definitions**: See `docs/glossary.md` § "Component Hierarchy" for full definitions and the layer diagram.

Components are the UI layer. They receive data via props or call hooks — they never fetch data or import services/APIs directly. See `data-pipeline.md` for the full API → Service → Hook → Component flow.

The hierarchy from smallest to largest:

| Layer           | Internal state?        | Lives in                          | Example                               |
| --------------- | ---------------------- | --------------------------------- | ------------------------------------- |
| **Atom**        | UI only (hover, focus) | `[atoms]/` or `[components]/`     | StatusBadge, Icon, ProgressBar        |
| **Molecule**    | Minimal (open/closed)  | `[molecules]/` or `[components]/` | SearchBar, AgentCard, MetricCard      |
| **Organism**    | Significant            | `[organisms]/` or `[components]/` | DataTable, AgentsTable, AgentTimeline |
| **Sub-feature** | —                      | `features/<parent>/<sub>/`        | `agent-timeline`, `agent-requests`    |
| **Feature**     | —                      | `features/<name>/`                | `agents`, `findings`, `policies`      |

"Container" components (e.g., `LayoutContainer`, `WizardContainer`) are just components that project children inside a layout or provider. They are not a separate architectural layer.

## Classification Checklist

When creating or reviewing a `.tsx` file:

1. **Primitive UI, no state beyond hover/focus?** → Atom. Put in `[atoms]/` (global) or `[components]/` (feature).
2. **Composed atoms, minimal interaction state?** → Molecule. Put in `[molecules]/` (global) or `[components]/` (feature).
3. **Complex UI region, significant state, no data fetching?** → Organism. Put in `[organisms]/` (global) or `[components]/` (feature).
4. **Projects children inside a layout or provider?** → Component with a `Container` suffix. Put in `[components]/`.
5. **One-off page section with no domain props?** → Layout. Co-locate with its page in `pages-content/`.

**Component ownership**: A component belongs to the feature that owns the domain concept it renders (e.g., `EndpointSummaryCard` belongs in `endpoints`, not `agent-control-groups`).

## Storybook Title Convention

| Scope                   | Title pattern                         | Example                                     |
| ----------------------- | ------------------------------------- | ------------------------------------------- |
| Global atom             | `Atoms/<Name>`                        | `Atoms/StatusBadge`                         |
| Global molecule         | `Molecules/<Name>`                    | `Molecules/SearchBar`                       |
| Global organism         | `Organisms/<Name>`                    | `Organisms/DataTable`                       |
| Feature-scoped atom     | `Features/<Feature>/Atoms/<Name>`     | `Features/Discovery/Atoms/DiscoveryPulse`   |
| Feature-scoped molecule | `Features/<Feature>/Molecules/<Name>` | `Features/Agents/Molecules/AgentCard`       |
| Feature-scoped organism | `Features/<Feature>/Organisms/<Name>` | `Features/Findings/Organisms/FindingsTable` |
