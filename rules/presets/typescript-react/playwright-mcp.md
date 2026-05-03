---
paths:
  - "src/**/*.tsx"
  - "src/**/*.css"
---

# Visual Verification of UI Changes

After making any visible UI change (layout, styling, component modifications, new components), visually verify the result using the `agent-browser` CLI via Bash:

1. **Navigate**: `agent-browser open http://localhost:3333/<path>`
2. **Screenshot**: `agent-browser screenshot` to capture current state
3. **Snapshot**: `agent-browser snapshot -i --json` for interactive elements with @refs
4. **Interact**: `agent-browser click @e1` or `agent-browser fill @e2 "text"`
5. **Evaluate** — check for layout issues, content rendering, and visual regressions
6. **If something looks wrong**, fix and re-verify before moving on

Skip this if the dev server isn't running or the change is non-visual (types, services, hooks with no UI).
