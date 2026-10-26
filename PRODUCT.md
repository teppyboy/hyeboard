# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

University students use Hyeboard to access academic information and workflows across supported university systems. Parent/guardian flows exist in the product, but students are the primary users.

## Product Purpose

Hyeboard is a multi-university student dashboard for timetables, grades, exams, tuition, courses, assignments, documents, notifications, and academic lookup tools. Success means students can use one browser interface to manage their supported university information without having to navigate each upstream system separately.

## Positioning

Hyeboard unifies academic tools from multiple supported universities behind one dashboard and API boundary. The browser communicates with Hyeboard rather than directly with university systems.

## Operating Context

Students use the web app during ordinary academic administration: checking schedules and grades, reviewing exams and tuition, accessing course and assignment information, reading documents and notifications, and performing supported academic lookups. Hyeboard currently supports VNU-UET through StudentHub and Canvas, VNU through `daotao.vnu.edu.vn`, and a Mock adapter for demos and local development.

## Capabilities and Constraints

- University capabilities are enabled only when adapter response shapes and behavior are verified.
- Unsupported features must remain explicitly unsupported; the UI must not invent upstream data or capability.
- Upstream credentials remain behind the API boundary and are wrapped in opaque encrypted Hyeboard session data.
- Student and admin authentication are separate flows.
- The web app supports Cloudflare and self-hosted Node/Bun runtime modes; distributed deployments use PostgreSQL, Redis, and Browserless.
- The admin dashboard controls feature availability and selected operational limits without bypassing adapter capabilities. Admin policy publication is reasoned, revisioned, and append-only.

## Brand Commitments

- Product name: Hyeboard.
- Existing product voice is direct, practical, and transparent about supported capabilities and upstream limitations.
- Future UI work should preserve truthful capability labels and avoid implying unsupported university behavior.

## Evidence on Hand

- Product overview and setup: `README.md`.
- Architecture and security boundaries: `docs/architecture.md` and `AGENTS.md`.
- Admin dashboard behavior and operations: `docs/admin-dashboard.md`.
- Current web implementation: `apps/web/src/`.
- Supported adapter registry and university implementations: `packages/university-adapters/`.
- No testimonials, customer studies, or external product claims are supplied; future work must not fabricate them.

## Product Principles

- One coherent dashboard across supported university systems.
- Keep credentials and upstream complexity behind the API boundary.
- Advertise only evidence-backed capabilities.
- Preserve separate, explicit student and admin workflows.
- Make operational state and limitations understandable to users.

## Accessibility & Inclusion

WCAG 2.2 AA is a product requirement for future interface work. Preserve and extend semantic controls, keyboard access, visible focus, accessible labels, practical touch targets, responsive layouts, loading/error/empty states, and sufficient contrast.
