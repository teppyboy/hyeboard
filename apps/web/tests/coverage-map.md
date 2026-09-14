# Optimized Playwright coverage ledger

Status: complete. Source inventory: 86 logical tests / 172 legacy two-project executions. Final allocation: 68 Chromium + 14 explicit `@webkit` + 4 Vitest CSV contracts.

Browser destinations retain the source assertion intent and exact source title. Repeated login setup is replaced by the test-scoped `authenticatedPage` fixture only where authentication is not asserted. Helpers are separated into `fixtures/base.ts`, `fixtures/vnu.ts`, `fixtures/lookup.ts`, and `helpers/export.ts`; mutable routes, counters, gates, pages, contexts, and identities remain test-local. No shared `storageState` exists.

| Legacy source | Assertion intent | Destination evidence | Disposition | Rationale |
| --- | --- | --- | --- | --- |
| 680–710, four tests | CSV parser closing-quote rejection, quoted controls, injected-record rejection, bulk order rejection | `src/lib/export/data-export.test.ts`, four same-purpose tests under `CSV` | exact, Vitest | Pure contracts need no browser. |
| 712–767, three tests | Anonymous gate; university sections; UET Google/manual paths | `auth-login.spec.ts`, same titles | exact, Chromium | Authentication integration. |
| 769–877, three tests | No VNU plaintext persistence; expiry cleanup; account-scoped grant import | `auth-login.spec.ts`, same titles | exact, Chromium | Browser storage/auth boundary. |
| 907–969, five logical tests | New-tab no-grant expiry and active/inactive live/expired descriptor removal | `vnu-session-lifecycle.spec.ts`, same generated titles | exact, Chromium | Tab-local session storage. |
| 1016–1080, four tests | Reconnect status, localization, scoped refetch, account switching | `vnu-session-lifecycle.spec.ts`, same titles | exact, Chromium | Browser event/query integration. |
| 1082–1412, seven tests | Revoke failure, pending ownership, owner close/navigation, superseded action, account switch | `vnu-session-lifecycle.spec.ts`, same titles | exact, Chromium | Stateful browser effects remain isolated. |
| 1414–1489, seven logical tests | Concurrent expiry and six nonterminal inline-error/account-retention cases | `vnu-session-lifecycle.spec.ts`, same/generated titles | exact, Chromium | UI/session integration retained once. |
| 1491 | School accent never stale | `auth-login.spec.ts`, same title | exact, Chromium | Login-theme state. |
| 1502–1528, two tests | Account menu/sign-out; real demo dashboard | `shell-dashboard.spec.ts`, same titles | exact, Chromium | Shell integration. |
| 1530–1665, seven tests | Mobile containment, labels, themes, sidebar, drawer, focus/touch | `shell-dashboard.spec.ts`, same titles; three mobile drawer/containment titles tagged `@webkit` | browser-specific | Desktop contracts Chromium; mobile-sensitive contracts WebKit. |
| 1667–1712, two tests | Header search/navigation; capability-gated Lookup absence | `shell-dashboard.spec.ts` and `lookup.spec.ts`, same titles | exact, Chromium | Bound navigation and capability UI. |
| 1714–1785, four tests | Progressive lookup controls/touch, point detail, bulk capability and limits | `lookup.spec.ts`, same titles; progressive/touch title tagged `@webkit` | browser-specific | Touch contract WebKit; data/UI contracts Chromium. |
| 1786–2268, ten tests | Bulk modes/order/chunks, partial/retry/cancel/refresh/reset/account isolation/pagination/malformed data | `lookup.spec.ts`, same titles | exact, Chromium | Browser-observable flow assertions retained. |
| 2270–2434, four tests | Single lookup exports, spaced codes, stale action removal, client validation | `lookup.spec.ts`, same titles | exact, Chromium | Forms/download/UI contracts. |
| 2436–2442 | Notifications trigger and content/empty state | `shell-dashboard.spec.ts`, same title | exact, Chromium | Shell menu integration. |
| 2444–2618, four tests | Grade term/default/merge/details/sort/GPA/CPA/export/collision/metadata gate plus export keyboard/theme/print/repeated failure/localization | `grades-export.spec.ts`, same titles | exact, Chromium | User-visible grade integration; default-browser behavior remains on Chromium. |
| 2620–2746 | Export keyboard/theme/print/failure/localization plus browser-sensitive download/focus/menu containment | `grades-export.spec.ts`; Chromium folds default-browser assertions into the grade/export integration, while the narrowed title `export menu keeps download focus and remains contained across viewports @webkit` retains only WebKit-sensitive evidence | split by contract | Chromium retains keyboard/theme/print/retry/localization; WebKit retains successful download, focus return, touch sizing, and viewport/menu containment. |
| 2748–2790, three tests | Desktop grid; mobile groups; tablet overflow | `timetable-features.spec.ts`, same titles; mobile/tablet tagged `@webkit` | browser-specific | Desktop Chromium; responsive behavior WebKit. |
| 2792–2841 | Every feature route renders bound UI; interactions; no JSON dumps | `timetable-features.spec.ts`, same title | exact, Chromium | Comprehensive route/proxy smoke. |
| 2843–2856 | VNU document compact/spaced search without refetch | `lookup.spec.ts`, same title | exact, Chromium | Bound filtering integration. |
| 2858–2987, three tests | Mobile login labels, CAPTCHA, inline re-auth | `auth-login.spec.ts`, same titles tagged `@webkit` | browser-specific | Mobile WebKit form/focus/stream behavior. |
| 2989–3067, four tests | About metadata, headings, aria-current, search label | `shell-dashboard.spec.ts`, same titles | exact, Chromium | Semantic shell coverage. |
| 3011–3032, three generated tests | No page overflow at phone/tablet/desktop sizes | 390/768 titles in `responsive-accessibility.spec.ts` tagged `@webkit`; 1440 title in `shell-dashboard.spec.ts` Chromium | browser-specific | Each viewport retained exactly once. |
| 3069–3153, three tests | Touch targets, internal table scroll, light/dark focus rings | `responsive-accessibility.spec.ts`; first two tagged `@webkit`, focus ring Chromium | browser-specific | Engine-sensitive layout versus desktop focus styling. |

## Allocation proof

| Domain spec | Chromium | WebKit |
| --- | ---: | ---: |
| `auth-login.spec.ts` | 7 | 3 |
| `vnu-session-lifecycle.spec.ts` | 23 | 0 |
| `shell-dashboard.spec.ts` | 13 | 3 |
| `lookup.spec.ts` | 18 | 1 |
| `grades-export.spec.ts` | 4 | 1 |
| `timetable-features.spec.ts` | 2 | 2 |
| `responsive-accessibility.spec.ts` | 1 | 4 |
| **Browser total** | **68** | **14** |

Vitest adds four pure CSV cases, reconciling final evidence to all 86 logical tests. Chromium `grepInvert: /@webkit/` and WebKit `grep: /@webkit/` enforce allocation.

## Generated-case expansion

These source loops count as separate logical tests and map to these exact destination titles:

| Source generator | Exact destination title | Destination |
| --- | --- | --- |
| New-tab descriptor matrix | `VNU new tab removes active live descriptor without a grant` | Chromium, `vnu-session-lifecycle.spec.ts` |
| New-tab descriptor matrix | `VNU new tab removes inactive live descriptor without a grant` | Chromium, `vnu-session-lifecycle.spec.ts` |
| New-tab descriptor matrix | `VNU new tab removes active fully expired descriptor without a grant` | Chromium, `vnu-session-lifecycle.spec.ts` |
| New-tab descriptor matrix | `VNU new tab removes inactive fully expired descriptor without a grant` | Chromium, `vnu-session-lifecycle.spec.ts` |
| Inline error matrix | `VNU code-less 401 remains inline and keeps the active account` | Chromium, `vnu-session-lifecycle.spec.ts` |
| Inline error matrix | `VNU_UNKNOWN_FAILURE remains inline and keeps the active account` | Chromium, `vnu-session-lifecycle.spec.ts` |
| Inline error matrix | `VNU_REQUEST_FAILED remains inline and keeps the active account` | Chromium, `vnu-session-lifecycle.spec.ts` |
| Inline error matrix | `VNU_RATE_LIMITED remains inline and keeps the active account` | Chromium, `vnu-session-lifecycle.spec.ts` |
| Inline error matrix | `VNU_UPSTREAM_UNAVAILABLE remains inline and keeps the active account` | Chromium, `vnu-session-lifecycle.spec.ts` |
| Inline error matrix | `VNU_CROSS_LOOKUP_NOT_FOUND remains inline and keeps the active account` | Chromium, `vnu-session-lifecycle.spec.ts` |
| Viewport matrix | `login, dashboard, timetable, and grades have no horizontal overflow at 390x844 @webkit` | WebKit, `responsive-accessibility.spec.ts` |
| Viewport matrix | `login, dashboard, timetable, and grades have no horizontal overflow at 768x1024 @webkit` | WebKit, `responsive-accessibility.spec.ts` |
| Viewport matrix | `login, dashboard, timetable, and grades have no horizontal overflow at 1440x900` | Chromium, `shell-dashboard.spec.ts` |

## Pure replacement evidence

| Source intent | Exact destination test |
| --- | --- |
| Reject characters after a closing CSV quote | `CSV > rejects characters after a closing quote` |
| Preserve quoted controls and doubled quotes | `CSV > preserves quoted controls and doubled quotes` |
| Reject an injected CSV record | `CSV > detects injected records against the exact export model` |
| Reject reordered bulk item groups | `CSV > detects reordered bulk item groups` |
| Account action ownership and supersession decisions | `account action ownership > publishes failure only for the exact pending generation and account token`; `keeps superseded and closed owners inert`; `requires a settings operation to retain active-account ownership`; `clears only matching pending and non-error owner state` |
| Grade sort, term identity, selection, and export ordering | `grade view model > sorts text and numeric columns in both directions without mutating input`; `keeps missing, reserved, spaced, and raw term identities collision-safe`; `selects newest, valid, and all-term views deterministically`; `constructs export terms in current sorted course order` |

Account-action and grade-model tests supplement named browser integrations; they do not increase the 86-test migration count because their surrounding browser assertions remain allocated above.
