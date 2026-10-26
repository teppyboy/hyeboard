# Admin Dashboard Design Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve the Hyeboard admin dashboard’s first-time orientation and audit-history usability while preserving its Quiet Command Center visual system, existing policy safety semantics, and WCAG 2.2 AA target.

**Architecture:** Keep the existing React/TanStack Router admin surface and admin API contract. Add a small reusable orientation/help component at the policy-control boundary, improve history’s local presentation and discoverability without inventing unsupported server-side search, and extend browser coverage for authenticated desktop/mobile keyboard and responsive paths. Do not change policy authority, authentication, revision conflict, rollback, or upstream capability rules.

**Tech Stack:** React 19, TanStack Router, TanStack Query, Tailwind CSS v4, TypeScript, Vitest, Playwright, existing i18n dictionaries and UI primitives.

**Spec:** `DESIGN.md`, `PRODUCT.md`, `docs/admin-dashboard.md`, and the critique snapshot `.impeccable/critique/2026-10-26T15-05-03Z__apps-web-src-pages-admin.md`.

## Global Constraints

- Preserve the Quiet Command Center visual system: calm, precise, warm, flat bordered sections, thin borders, restrained accents.
- Preserve the existing product distinction: one dashboard across supported universities.
- Preserve adapter capability ceilings; the UI must not imply unsupported features are configurable.
- Preserve separate admin/student authentication and never read or expose student credentials in admin UI.
- Every app-authored string must be added to both English and Vietnamese typed dictionaries.
- WCAG 2.2 AA is the target: semantic structure, keyboard operation, visible focus, labels, contrast, practical touch targets, and clear status/error messaging.
- Do not add dependencies, new API endpoints, or server-side history filters unless an existing contract is expanded with a separate approved task.
- Keep app screens code-first and use existing UI primitives; no visual redesign or decorative dashboard chrome.

## Review Focus

- **Dismissed orientation state:** Reloading after dismissal must not reintroduce the help block within the same admin session; test with a fresh browser context to confirm first-run visibility.
- **Long localized copy:** English and Vietnamese orientation/help text must wrap without horizontal overflow at 390px and 1440px; test both locales.
- **Locked capability comprehension:** A locked unsupported/global-disabled row must retain its explicit reason and must not become interactable due to help/filter presentation changes; test one capability in each lock state.
- **History empty/loading/error continuity:** The new history presentation must preserve existing loading, empty, error, retry, detail, rollback, and conflict states; test at least empty and populated paths plus one retry.
- **Keyboard and touch parity:** Orientation dismissal, history controls, scope tabs, policy switches, Review, and dialogs must remain keyboard-operable with visible focus and at least 44px primary targets on mobile; test Chromium desktop/mobile viewport contracts.

### Task 1: Add first-time admin orientation and help content

**Files:**
- Create: `apps/web/src/components/admin/admin-orientation.tsx`
- Modify: `apps/web/src/components/admin/policy-editor.tsx`
- Modify: `apps/web/src/pages/admin/admin-control.tsx` only if the editor boundary requires a prop/wiring change
- Modify: `apps/web/src/lib/i18n.tsx` in both `en.admin` and `vi.admin`
- Test: `apps/web/src/components/admin/admin-components.test.tsx` or a focused new `apps/web/src/components/admin/admin-orientation.test.tsx`
- Test: `apps/web/tests/admin-feature-control.spec.ts`

**Interfaces:**
- Produces `AdminOrientation({ onDismiss?: () => void })`, a semantic `aside`/`section` with a heading, concise lifecycle explanation, and dismiss button.
- Consumes existing `useLocale`, `Button`, and design tokens; no API calls and no new persistence mechanism beyond a session-local browser key owned by the component.

- [ ] **Step 1: Write failing component tests**
  - Assert the orientation renders a heading and three concise steps: stage changes, review the exact diff, publish with a reason.
  - Assert the dismiss control has a localized accessible name and invokes the dismissal callback.
  - Assert the content explains that locked controls reflect adapter support or policy ceilings without changing any switch state.
  - Assert both English and Vietnamese dictionaries contain all orientation keys.

- [ ] **Step 2: Run the focused component test to verify it fails**

Run: `pnpm --filter @hyeboard/web exec vitest run src/components/admin/admin-orientation.test.tsx` (or the updated existing test file)

Expected: FAIL because the orientation component and/or translation keys do not yet exist.

- [ ] **Step 3: Implement the orientation component**
  - Render a flat bordered section near the policy title/search boundary, not a modal.
  - Use existing `bg-muted`, `border-border`, `text-foreground`, and `text-muted-foreground` tokens; avoid new shadows, gradients, nested cards, or colored side stripes.
  - Use a semantic heading, ordered list for the lifecycle, explanatory text for locked controls, and a 44px minimum dismiss button.
  - Keep copy direct and product-specific; do not claim that every upstream capability is available.
  - Store dismissal only in `sessionStorage` under a namespaced non-secret key, or keep the component controlled by the page if the existing test seam makes that smaller. Never store credentials or admin tokens.

- [ ] **Step 4: Wire orientation into policy control**
  - Show it only on the initial clean control-room view; hide it after dismissal for the current tab/session.
  - Do not show it over a loading, error, or empty API state.
  - Preserve existing search, scope tabs, capability locks, staged action bar, and dialog behavior.

- [ ] **Step 5: Run focused tests to verify they pass**

Run: `pnpm --filter @hyeboard/web exec vitest run src/components/admin/admin-orientation.test.tsx src/components/admin/admin-components.test.tsx`

Expected: PASS with all existing admin component assertions and the new orientation assertions.

- [ ] **Step 6: Add the browser regression**
  - In `apps/web/tests/admin-feature-control.spec.ts`, assert first visit shows the orientation, dismissal hides it, and reload in the same context keeps it hidden.
  - Assert the policy controls remain available after dismissal and no student storage changes occur.
  - Exercise both desktop and mobile viewport variants for no overflow and button target sizing.

- [ ] **Step 7: Run the browser regression**

Run: `pnpm --filter @hyeboard/web exec playwright test tests/admin-feature-control.spec.ts --project=chromium --retries=0`

Expected: PASS; orientation and existing admin flow tests remain green.

- [ ] **Step 8: Commit the task**

```bash
git add apps/web/src/components/admin/admin-orientation.tsx apps/web/src/components/admin/policy-editor.tsx apps/web/src/lib/i18n.tsx apps/web/src/components/admin/admin-orientation.test.tsx apps/web/tests/admin-feature-control.spec.ts
git commit -m "feat(web): orient admin policy operators"
```

### Task 2: Improve history discoverability without changing the API contract

**Files:**
- Modify: `apps/web/src/components/admin/policy-history.tsx`
- Modify: `apps/web/src/pages/admin/admin-history.tsx` only for presentation state if required
- Modify: `apps/web/src/lib/i18n.tsx` in both `en.admin.history` and `vi.admin.history`
- Test: `apps/web/src/components/admin/admin-components.test.tsx` or a focused `apps/web/src/components/admin/policy-history.test.tsx`
- Test: `apps/web/tests/admin-policy-conflicts.spec.ts` and/or `apps/web/tests/admin-feature-control.spec.ts`

**Interfaces:**
- Keep `PolicyHistoryProps` and `adminApi.history({ limit, beforeRevision })` unchanged.
- Add only local presentation behavior: a visible history summary, clear revision metadata, and an explicit “load more” explanation/state. Do not promise search or filtering the backend cannot perform.

- [ ] **Step 1: Write failing history presentation tests**
  - Assert populated history exposes a concise accessible summary explaining newest-first revisions and the available load-more action.
  - Assert the empty state includes a short explanation of what creates a revision, while retaining the existing empty-state status role.
  - Assert loading-more and load-more-error states retain disabled/retry semantics and accessible status text.

- [ ] **Step 2: Run focused tests to verify they fail**

Run: `pnpm --filter @hyeboard/web exec vitest run src/components/admin/policy-history.test.tsx` (or the updated existing test file)

Expected: FAIL because the new summary/empty-state copy and assertions do not yet exist.

- [ ] **Step 3: Implement the presentation improvement**
  - Add one short explanatory line under the history heading or within the list header: revisions are immutable, newest first, and rollback publishes a new revision.
  - Keep revision actor, timestamp, reason, detail, rollback, conflict, retry, and pagination behavior intact.
  - Improve the visual scan of each row using existing divider, metadata, and button patterns; do not add metric-card scaffolding or decorative badges beyond the existing auth-method label.
  - Ensure long actors/reasons wrap, and maintain mobile target sizes and no horizontal overflow.

- [ ] **Step 4: Add both-locale copy and component assertions**
  - Add typed English/Vietnamese strings for the history orientation and empty-state explanation.
  - Assert no raw hard-coded app-authored copy is introduced in the component.

- [ ] **Step 5: Run focused tests to verify they pass**

Run: `pnpm --filter @hyeboard/web exec vitest run src/components/admin/policy-history.test.tsx src/components/admin/admin-components.test.tsx`

Expected: PASS.

- [ ] **Step 6: Extend browser coverage**
  - Assert populated history shows the orientation text and can open revision detail.
  - Assert the empty history page shows the explanation.
  - Preserve existing rollback conflict, retry, and pagination tests.

- [ ] **Step 7: Run the focused browser specs**

Run: `pnpm --filter @hyeboard/web exec playwright test tests/admin-feature-control.spec.ts tests/admin-policy-conflicts.spec.ts --project=chromium --retries=0`

Expected: PASS.

- [ ] **Step 8: Commit the task**

```bash
git add apps/web/src/components/admin/policy-history.tsx apps/web/src/pages/admin/admin-history.tsx apps/web/src/lib/i18n.tsx apps/web/src/components/admin/policy-history.test.tsx apps/web/tests/admin-feature-control.spec.ts apps/web/tests/admin-policy-conflicts.spec.ts
git commit -m "feat(web): clarify admin policy history"
```

### Task 3: Run the complete admin quality gate and visual verification

**Files:**
- Modify only if verification finds a concrete defect in the previous tasks.
- Test: `apps/web/tests/admin-feature-control.spec.ts`
- Test: `apps/web/tests/admin-policy-conflicts.spec.ts`

**Interfaces:**
- Consumes the completed orientation and history presentation behavior from Tasks 1–2.
- Produces a verified admin flow at desktop and mobile sizes, both locales, keyboard interaction, visible focus, and no overflow.

- [ ] **Step 1: Run the complete web unit/type gate**

Run: `pnpm --filter @hyeboard/web test`

Expected: PASS with all web test files and tests passing.

- [ ] **Step 2: Run admin browser coverage**

Run: `pnpm --filter @hyeboard/web exec playwright test tests/admin-feature-control.spec.ts tests/admin-policy-conflicts.spec.ts --project=chromium --retries=0`

Expected: PASS with no console/page errors, no page overflow, keyboard-operated switches/dialogs, and 44px mobile targets.

- [ ] **Step 3: Run the design detector on changed admin targets**

Run: `/home/tretrauit/.agents/skills/impeccable/scripts/impeccable detect --json apps/web/src/components/admin apps/web/src/pages/admin`

Expected: zero findings, or only documented intentional findings with no warning-level issue.

- [ ] **Step 4: Run the web production build**

Run: `pnpm --filter @hyeboard/web build`

Expected: exit 0 and admin chunks included in the built output.

- [ ] **Step 5: Perform the bounded live review**
  - Review `/admin`, `/admin/history`, and `/admin/auth` at 1440×900 and 390×844 with authenticated test state.
  - Check orientation dismissal, history explanation, focus visibility, no horizontal overflow, loading/empty/error states, and no console errors.
  - Check English and Vietnamese copy wrapping.
  - If the live password limiter blocks the check, use the isolated mocked Playwright fixtures rather than mutating production credentials or weakening rate limits.

- [ ] **Step 6: Review the diff and commit verification changes if any**

Run: `git diff --check && git status --short --untracked-files=all`

Expected: only intended source/tests/docs changes remain; no secrets, screenshots, build output, or temporary artifacts are staged.

- [ ] **Step 7: Commit any final fixes**

```bash
git add <only-intended-files>
git commit -m "test(web): verify admin dashboard refinements"
```

- [ ] **Step 8: Push after all commits and fresh verification**

```bash
git push origin master
```

Expected: push succeeds and `git status --short` is clean except for intentionally ignored local secrets.
