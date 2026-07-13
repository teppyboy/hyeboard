# University Dashboard Redesign

## Problem

Hyeboard exposes the required university features, but its interface still resembles a generic SaaS dashboard. Repeated equal-sized metric cards, nested cards, uppercase metric labels, raw status values, and raw term codes weaken information hierarchy and make academic data harder to scan. The desktop timetable wastes space when most cells are empty, while its seven-column layout does not translate well to mobile. Login inputs rely on placeholders as labels, causing important instructions to truncate on narrow screens.

The redesign must feel like a complete university portal, remain understandable without training, and work across mobile, tablet, and desktop. It must preserve all existing routes, data sources, session behavior, university capabilities, themes, and English/Vietnamese localization.

## Design Direction

Use a restrained institutional-portal language with higher information density than the current interface. The UI should prioritize schedules, deadlines, academic results, and account context over decorative whitespace.

- Keep the existing Geist-based typography, CSS-variable theme system, light/dark modes, and user-adjustable UET hue.
- Use one accent color from the active theme. Reserve red, amber, green, and neutral colors for semantic statuses.
- Use normal-case labels and tabular numbers. Avoid repeated uppercase monospace eyebrows.
- Use cards only for meaningful section boundaries. Inside a section, use flat rows and `divide-y` separators rather than nested cards.
- Keep the established radius scale and subtle borders. Do not add gradients, glass effects, glow effects, side-stripe accents, or shadow-based hover effects.
- Keep Lucide as the single icon family because it is already the project's icon system.
- Preserve complete loading, empty, error, and unsupported states on every data-bound route.

## Scope

This is a hybrid redesign:

1. Restructure the application shell and mobile drawer.
2. Deeply redesign Dashboard and Timetable.
3. Improve density, hierarchy, responsive behavior, and technical data labels on all other pages.
4. Split the monolithic `main.tsx` while performing the redesign.
5. Update automated and visual tests for the new structure.

The change does not add backend features, modify adapter capabilities, change API contracts, invent unavailable university data, or replace the existing design primitives.

## Frontend Structure

Split the current monolithic entry point into bounded modules:

```text
apps/web/src/
├── main.tsx
├── router.tsx
├── state.tsx
├── components/
│   ├── ui/
│   ├── layout.tsx
│   └── shared.tsx
└── pages/
    ├── dashboard.tsx
    ├── timetable.tsx
    ├── courses.tsx
    ├── assignments.tsx
    ├── grades.tsx
    ├── exams.tsx
    ├── tuition.tsx
    ├── documents.tsx
    ├── training-points.tsx
    ├── settings.tsx
    └── login.tsx
```

- `main.tsx` initializes React and providers only.
- `router.tsx` owns the code-based TanStack route tree and auth redirects.
- `state.tsx` owns `HyeboardProvider`, `useHyeboard`, and `useFeatureQuery`.
- `components/layout.tsx` owns the root shell, sidebar, mobile drawer, search, notifications, and account menu.
- `components/shared.tsx` owns reusable composed UI such as page headers, summary strips, data tables, status badges, skeletons, empty states, and query-error panels.
- Each route page owns its page-specific rendering and local helpers. Login-only helpers remain with `login.tsx` unless reused elsewhere.
- Existing low-level primitives stay in `components/ui`; existing API, i18n, and utility modules remain in `lib`.

This split is part of the redesign, but it must not create new abstractions solely to reduce line counts. Shared components require at least two real consumers or a clear cross-page responsibility.

## Application Shell

### Sidebar

Group navigation by user intent:

- Overview: Dashboard
- Study: Timetable, Courses, Assignments, Grades, Exams
- Services: Tuition, Documents, Training Points
- System: Settings

Group labels must be localized and visually quieter than links. Keep the current collapse behavior on desktop. The university identity block remains at the top and shows the active university clearly. Remove the git commit from the production sidebar; expose version information in Settings instead.

### Header

Use a compact header. Keep the mobile menu button, search, notifications, and account menu, but reduce the visual weight of search. Search may render as a compact trigger that opens the existing navigation search surface; keyboard and screen-reader behavior must remain available.

Page-specific title, description, term controls, and date context belong in the page content through one consistent page-header pattern, not in a second global navigation bar.

### Mobile Navigation

Keep the existing drawer rather than adding a bottom tab bar. Apply the same navigation grouping as desktop, use at least 44px touch targets, retain visible active-route state, and ensure the drawer can be operated and dismissed by keyboard and touch.

## Dashboard

Combine the greeting, active term, student identity, current date, and next-class context into one compact page header. Student and term values should read as context, not competing badges.

Replace the row of independent metric cards with one bordered summary strip. GPA/CPA, credits, assignments needing attention, and tuition balance become divided statistics with normal-case labels and tabular numbers. On narrow screens the strip wraps into two columns without horizontal overflow.

Use a responsive two-column content layout on wide screens and one column on mobile:

- Today's Schedule: chronological flat rows with time, course, room, instructor, and available class link.
- Assignment Timeline: due-date-oriented rows with localized semantic statuses.
- Active Courses: flat rows within one section; no course cards nested inside a parent card.
- Recent Notifications: compact source, title, and time rows.

Every section keeps an explicit empty state. No new data or progress inference may be fabricated.

## Timetable

Keep both calendar and list views.

Desktop calendar:

- Retain verified period and clock-time labels already supplied by the application.
- Increase density and make course code, title, room, and period easier to scan.
- Mark the current weekday using a restrained background treatment.
- Hide Sunday when it has no sessions; show it when real data exists.
- Render sessions as flat, accent-tinted blocks within the grid, not elevated cards.
- Preserve external class links only when a safe URL exists.

Mobile and narrow tablet:

- Replace the seven-column calendar with a vertical day-grouped schedule.
- Show only days represented by the selected week or required empty-state context.
- Keep periods, times, room, instructor, and links readable without horizontal scrolling.
- The explicit List/Calendar control remains, but both modes must resolve to mobile-appropriate layouts rather than a compressed desktop grid.

## Remaining Pages

### Grades

Replace raw recognized UET term codes with localized academic labels such as `Semester 1, 2025–2026`. Preserve unrecognized codes verbatim rather than guessing. Replace repeated per-term metric-card trios with a compact inline summary followed by the grade table. Retain sortable columns and summer-term indicators.

### Assignments, Exams, and Tuition

Use localized semantic labels for known backend status values. Keep raw values in data and API layers; transform only the presentation. Lists and tables should emphasize deadline/date, course or bill identity, status, and required action. Financial values remain VND-formatted.

### Courses, Documents, and Training Points

Use the shared page-header and flat-list language. Preserve search, links, capability handling, and explicit empty states. Avoid adding controls that the backend cannot support.

### Login

Add persistent visible labels above username, password, token, cookie, and verification inputs. Placeholders may show examples but must not carry essential instructions. Keep all Google, parent/guardian, VNU, demo, manual-token, CAPTCHA, and language-toggle flows unchanged. The form must fit a 390px viewport without clipped labels or horizontal overflow.

### Settings

Keep color mode, theme style, UET hue, language, account, and sign-out controls. Add an About row for the Hyeboard version/commit currently shown in the sidebar. Version information must remain secondary and non-interactive.

## Human-Readable Data

Add a presentation-only status formatter used by a shared status badge. Map known values such as `in_progress`, `not_started`, `missing`, `submitted`, `graded`, `late`, `active`, `paid`, `unpaid`, and `credit` to localized labels and semantic tones. Normalize unknown values by replacing separators and applying readable casing; never discard an unknown upstream value.

Add a term-label formatter for verified UET term-code patterns. It must use existing university-specific term rules, localize semester and academic-year text, identify summer terms where supported, and return the original value for malformed or unknown formats.

All new app-authored text and known display mappings must be added to both dictionaries in `lib/i18n.tsx`. This supersedes the previous UI policy of displaying all backend enums raw: underlying values remain untranslated, while known presentation labels are localized for usability.

## Responsive and Accessible Behavior

- Support 390px mobile, 768px tablet, and 1440px desktop reference viewports.
- Declare the mobile fallback for every multi-column region in its component.
- Prevent page-level horizontal scrolling at all reference widths.
- Use at least 44px touch targets for primary mobile navigation and form controls.
- Preserve semantic heading order, visible labels, keyboard interaction, focus rings, accessible names, and WCAG AA contrast.
- Verify light and dark modes with neutral Demo and colored UET palettes.
- Limit motion to functional state transitions and respect `prefers-reduced-motion`.

## State and Error Handling

Continue using TanStack Query and `useFeatureQuery`. Session-death errors retain current redirect behavior; feature-specific errors remain inline and must not clear valid sessions. Skeletons should approximate final section geometry. Empty, unsupported, Canvas-required, login-required, and general query-error states remain explicit and localized.

The file split must not change query keys, caching, account switching, session import, theme persistence, locale persistence, or router auth guards.

## Testing

Update `apps/web/tests/smoke.spec.ts` alongside visible DOM changes. Preserve existing behavioral coverage and add assertions for:

- Grouped desktop navigation and polished mobile drawer.
- Every feature route rendering bound UI without raw JSON or nested-card regressions.
- Dashboard summary strip, schedule, assignment, course, and notification sections.
- Desktop timetable grid and mobile day-grouped timetable.
- Human-readable status labels with no visible known `snake_case` values.
- Localized recognized term labels and safe fallback for unknown codes.
- Login labels remaining visible at 390px.
- Search, notifications, account menu, sign-out, language controls, theme controls, and sidebar collapse continuing to work.

Run the following completion gate from the repository root:

```bash
pnpm build
pnpm test
pnpm --filter @hyeboard/web exec playwright test
```

Perform screenshot review at 390x844, 768x1024, and 1440x900 for Dashboard, Timetable, Grades, and Login. Check both locales and both color modes, with at least one neutral Demo session and one UET-themed state. Inspect browser console errors and verify no page-level horizontal overflow. The redesign is not complete until automated tests pass and the rendered pages are manually confirmed usable.

## Implementation Risk Controls

- Extract and redesign one coherent module group at a time, running web typechecks between groups.
- Avoid parallel edits to the same source file when using subagents.
- Keep router and provider behavior mechanically equivalent while moving code.
- Add shared formatters before converting page call sites.
- Update tests in the same change as each visible structural change.
- Stage only intentional files; leave unrelated worktree files untouched.
