---
paths:
  - "e2e/**"
---

# E2E Test Rules

**NEVER use `test.skip()` in E2E tests.** This is non-negotiable.

- **Missing data**: If a test requires data (table rows, agents, endpoints, chart segments) and none exist, the test must **fail with an assertion**, not skip. Empty data in a test environment is a real problem that needs to surface. Use `expect(count).toBeGreaterThan(0)` — not `if (count === 0) { test.skip() }`.
- **Unrendered elements**: If a UI element (chart, dialog, page shell, button) doesn't appear, the test must **fail**, not skip. An element not rendering is a bug. Use `await expect(element).toBeVisible()` — not `if (!visible) { test.skip() }`.
- **Auth failures**: If the page redirects to `/login` when it shouldn't, the test must **fail**. Auth being broken is a real failure. Assert `await expect(page).not.toHaveURL(/login/)`.
- **No timeout bumping**: Do not increase static timeout values to paper over timing issues. Instead, wait for real DOM signals (element visibility, attribute changes, URL updates) using Playwright's auto-retrying assertions (`toBeVisible`, `toHaveURL`, `toHaveAttribute`).
- **No silent swallowing**: Do not use `.catch(() => {})` to swallow errors on assertions or element waits that are prerequisites for the test. If the prerequisite fails, the test should fail.

**What to do instead of skipping:**

1. **Assert preconditions** — use `expect()` to verify data/elements exist. If they don't, the test fails and tells you something is wrong.
2. **Wait for DOM signals** — use Playwright's auto-retrying assertions to wait for elements to appear, attributes to update, or URLs to change.
3. **Handle both states explicitly** — if a test genuinely covers two valid states (e.g., "shows rows OR empty state message"), use an `if/else` with assertions in both branches.

## Behavior Documentation (Living Spec)

**IMPORTANT**: The per-feature files in `e2e/behaviors/` are the source of truth for all feature behaviors. Each feature has its own file (e.g., `e2e/behaviors/dashboard.json`). E2E tests are derived from and validated against this spec.

**Full documentation**: See `docs/behaviors-system.md` for complete guide.

### When to Update Behavior Files

You MUST update the appropriate `e2e/behaviors/<feature>.json` file when:

- **Adding a new feature**: Create `e2e/behaviors/<feature>.json` with behaviors describing what the feature should do
- **Modifying feature behavior**: Update the existing behavior in the feature's file
- **Removing a feature**: Delete the feature's behavior file
- **Fixing a bug that changes behavior**: Update the behavior description in the feature's file

The behavior ID prefix tells you which file to edit: `dashboard.stats-grid.visible` → `e2e/behaviors/dashboard.json`.

### Quick Lookup Commands

```bash
npm run behavior <query>              # Search by ID prefix or keyword
npm run behavior -- --id <exact-id>   # Exact ID lookup
npm run behavior -- --feature agents  # All behaviors for a feature
npm run behavior -- --tag validation  # All behaviors with a tag
npm run behavior -- --keyword wizard  # Search in descriptions
npm run behavior:all                  # List all behavior IDs
npm run behavior:features             # List all features
```

### Behavior ID Convention

IDs follow the pattern: `feature.group.action`

Examples:

- `agents.list.search-by-name`
- `policies.create.wizard`
- `auth.login.success`

### Linking E2E Tests to Behaviors

When writing E2E tests, add a `@behavior` annotation:

```typescript
// @behavior agents.list.search-by-name
test('should search agents by name', async ({ page }) => {
  // test implementation
});
```

### Validation

Run `npm run e2e:behaviors` to see coverage report showing:

- Which behaviors have E2E test coverage
- Which behaviors are missing tests
- Coverage by feature and priority
