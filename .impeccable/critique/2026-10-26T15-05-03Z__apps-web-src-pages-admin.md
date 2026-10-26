---
target: apps/web/src/pages/admin
total_score: 34
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 0
target_identity: "file:/home/tretrauit/workspace/hyeboard/apps/web/src/pages/admin"
timestamp: 2026-10-26T15-05-03Z
slug: apps-web-src-pages-admin
---
## Design Health Score

| # | Heuristic | Score | Key issue |
|---|---|---:|---|
| 1 | Visibility of System Status | 3/4 | Loading, error, empty, conflict, and staged states are represented; live authenticated state was not re-tested in this pass. |
| 2 | Match System / Real World | 4/4 | Policy, capability, revision, provenance, and rollback language matches the product’s operational model. |
| 3 | User Control and Freedom | 3/4 | Discard, retry, logout, and rollback are present; conflict handling preserves drafts but requires a deliberate re-review. |
| 4 | Consistency and Standards | 4/4 | Admin routes use shared tokens, primitives, labels, focus treatment, and responsive conventions. |
| 5 | Error Prevention | 4/4 | Publish requires a reason; unsupported capabilities are locked; stale revisions are rejected. |
| 6 | Recognition Rather Than Recall | 4/4 | Navigation labels, capability descriptions, provenance, ceilings, and status copy are explicit. |
| 7 | Flexibility and Efficiency | 3/4 | Search and scoped policy tabs help operators, but there are no power-user shortcuts or denser history filters. |
| 8 | Aesthetic and Minimalist Design | 4/4 | Flat bordered sections and restrained tokens avoid decorative dashboard noise. |
| 9 | Error Recovery | 3/4 | Retry, conflict preservation, and rollback are strong; recovery guidance could be more contextual in some API failure states. |
| 10 | Help and Documentation | 2/4 | Operational documentation exists in docs/admin-dashboard.md, but the UI itself has little contextual help for first-time administrators. |
| **Total** |  | **34/40** | **Good; focused refinement recommended** |

## Design Specificity

The admin surface is product-specific rather than category-interchangeable. Its structure reflects Hyeboard’s real policy model: global versus university scope, adapter ceilings, staged changes, immutable revisions, rollback, and conflict preservation. The visual language matches the Quiet Command Center direction.

The deterministic target scan found zero findings across apps/web/src/pages/admin and apps/web/src/components/admin. No detector false positives were produced for the target.

## Overall Impression

The admin dashboard is already coherent and operationally credible. Its strongest opportunity is making first-time administrator orientation and contextual help more immediate without increasing dashboard chrome.

## What’s Working

1. Policy editing is clearly staged; the persistent action bar makes draft versus published state visible.
2. The UI reflects the domain accurately: locked capabilities, native ceilings, provenance, revision conflicts, and rollback are explicit.
3. Responsive structure is disciplined; desktop rail becomes mobile navigation and live mobile probing showed no horizontal overflow.
4. The visual system is restrained: neutral surfaces, thin borders, and limited shadow use support scanning.

## Priority Issues

### [P2] First-time admin orientation is thin

Add a compact, dismissible orientation block or contextual help affordance near the first policy heading. Explain stage → review → publish, the reason requirement, and why some controls are locked.

### [P2] History navigation lacks operator filtering

As revisions accumulate, load-more pagination may become inefficient. Add search/filter only if the API contract supports it; otherwise improve visible metadata and retain bounded pagination.

### [P3] Authenticated surface needs a regular visual regression pass

The live password login was rate-limited during this pass, so authenticated desktop/mobile/dark/theme review should be run with isolated test credentials or a reset test rate-limit bucket.

## Persona Red Flags

- Alex, power user: no keyboard shortcuts for scope switching, staged changes, or Review; repeated sessions may feel click-heavy.
- Jordan, first-time admin: publish lifecycle and terms such as native ceiling/provenance are not taught directly in the UI.
- Riley, keyboard/WCAG user: source inspection shows semantic controls, labels, visible focus rings, and practical touch targets; authenticated keyboard walkthrough remains unverified in this pass.

## Minor Observations

- Neutral theme is intentionally monochrome; UET/VNU themes provide identity when selected.
- Loading, error, empty, disabled, and conflict states are represented in source and tests.
- Broader repository detector findings are unrelated legacy values; scoped admin scan is clean.
- Existing large web chunks are not admin-specific regressions.

## Questions to Consider

- Could a first-time admin understand the publish lifecycle without opening docs/admin-dashboard.md?
- Would a compact publish explanation reduce hesitation more than another metric?
- As history grows, is load-more enough, or should the product define searchable audit semantics?
